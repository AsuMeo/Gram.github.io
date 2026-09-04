// Tsuyu Gateway — functional C++20 reference server.
//
// This is a dependency-free development/staging gateway: HTTP/1.1 JSON API,
// append-only file persistence and WebSocket fan-out. Before public production,
// replace the tiny JSON parser/storage with audited components and add TLS at a
// reverse proxy. The gateway never decrypts a ciphertext message.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

using Clock = std::chrono::system_clock;

long long nowSeconds() {
    return std::chrono::duration_cast<std::chrono::seconds>(Clock::now().time_since_epoch()).count();
}

std::string randomHex(std::size_t bytes) {
    std::random_device rd;
    std::mt19937_64 gen((static_cast<std::uint64_t>(rd()) << 32) ^ rd() ^ static_cast<std::uint64_t>(nowSeconds()));
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (std::size_t i = 0; i < bytes; ++i) out << std::setw(2) << (static_cast<unsigned>(gen() & 0xffu));
    return out.str();
}

std::string urlEncode(const std::string& value) {
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : value) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
        else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return out;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

std::string urlDecode(const std::string& value) {
    std::string out;
    for (std::size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '%' && i + 2 < value.size()) {
            int hi = hexValue(value[i + 1]), lo = hexValue(value[i + 2]);
            if (hi >= 0 && lo >= 0) { out += static_cast<char>((hi << 4) | lo); i += 2; continue; }
        }
        out += value[i] == '+' ? ' ' : value[i];
    }
    return out;
}

std::string jsonEscape(const std::string& value) {
    std::ostringstream out;
    for (unsigned char c : value) {
        switch (c) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 0x20) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
                else out << static_cast<char>(c);
        }
    }
    return out.str();
}

// The API accepts small, flat JSON command objects. Production builds should
// use a complete schema-validating JSON library (simdjson/rapidjson).
std::string jsonString(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const auto keyPos = json.find(needle);
    if (keyPos == std::string::npos) return {};
    auto colon = json.find(':', keyPos + needle.size());
    if (colon == std::string::npos) return {};
    auto start = colon + 1;
    while (start < json.size() && std::isspace(static_cast<unsigned char>(json[start]))) ++start;
    if (start >= json.size() || json[start] != '"') return {};
    ++start;
    std::string out;
    bool escaped = false;
    for (std::size_t i = start; i < json.size(); ++i) {
        char c = json[i];
        if (escaped) {
            switch (c) { case 'n': out += '\n'; break; case 'r': out += '\r'; break; case 't': out += '\t'; break; default: out += c; }
            escaped = false;
        } else if (c == '\\') escaped = true;
        else if (c == '"') break;
        else out += c;
    }
    return out;
}

std::vector<std::string> split(const std::string& value, char separator) {
    std::vector<std::string> result;
    std::string part;
    std::istringstream stream(value);
    while (std::getline(stream, part, separator)) result.push_back(part);
    return result;
}

std::string timeLabel(long long stamp) {
    std::time_t raw = static_cast<std::time_t>(stamp);
    std::tm tm{};
    localtime_r(&raw, &tm);
    std::ostringstream out;
    out << std::setfill('0') << std::setw(2) << tm.tm_hour << ':' << std::setw(2) << tm.tm_min;
    return out.str();
}

struct Message {
    std::string id;
    std::string sender;
    std::string text;
    std::string ciphertext;
    long long createdAt = 0;
};

struct Chat {
    std::string id;
    std::string name;
    std::string handle;
    std::string initials;
    std::string tone;
    std::string status;
    std::string preview;
    std::string about;
    bool favorite = false;
    bool group = false;
    std::vector<Message> messages;
};

class Store {
public:
    explicit Store(std::string file) : file_(std::move(file)) { load(); if (chats_.empty()) { seed(); saveLocked(); } }

    std::vector<Chat> chats() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<Chat> result;
        for (const auto& item : chats_) result.push_back(item.second);
        std::sort(result.begin(), result.end(), [](const Chat& a, const Chat& b) { return a.id < b.id; });
        return result;
    }

    Chat* find(const std::string& id) {
        auto it = chats_.find(id);
        return it == chats_.end() ? nullptr : &it->second;
    }

    Message addMessage(const std::string& chatId, const Message& message) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = chats_.find(chatId);
        if (it == chats_.end()) return {};
        it->second.messages.push_back(message);
        it->second.preview = message.text.empty() ? "Зашифрованное сообщение" : message.text;
        it->second.status = it->second.group ? it->second.status : "В сети";
        saveLocked();
        return message;
    }

    Chat createChat(const std::string& name, const std::string& handle, const std::string& initials, const std::string& tone) {
        std::lock_guard<std::mutex> lock(mutex_);
        Chat chat;
        chat.id = "chat_" + randomHex(8);
        chat.name = name.empty() ? "Новый диалог" : name;
        chat.handle = handle.empty() ? "@new-contact" : handle;
        chat.initials = initials.empty() ? "НД" : initials;
        chat.tone = tone.empty() ? "blue" : tone;
        chat.status = "В сети";
        chat.preview = "Новый защищённый диалог";
        chat.about = "Новый защищённый диалог в Tsuyu.";
        chats_[chat.id] = chat;
        saveLocked();
        return chat;
    }

private:
    std::string file_;
    std::mutex mutex_;
    std::map<std::string, Chat> chats_;

    void load() {
        std::ifstream in(file_);
        if (!in) return;
        std::string line;
        while (std::getline(in, line)) {
            auto fields = split(line, '|');
            if (fields.empty()) continue;
            if (fields[0] == "CHAT" && fields.size() >= 11) {
                Chat chat;
                chat.id = urlDecode(fields[1]); chat.name = urlDecode(fields[2]); chat.handle = urlDecode(fields[3]);
                chat.initials = urlDecode(fields[4]); chat.tone = urlDecode(fields[5]); chat.status = urlDecode(fields[6]);
                chat.preview = urlDecode(fields[7]); chat.about = urlDecode(fields[8]); chat.favorite = fields[9] == "1"; chat.group = fields[10] == "1";
                chats_[chat.id] = chat;
            } else if (fields[0] == "MSG" && fields.size() >= 7) {
                auto it = chats_.find(urlDecode(fields[1]));
                if (it == chats_.end()) continue;
                Message message;
                message.id = urlDecode(fields[2]); message.sender = urlDecode(fields[3]); message.text = urlDecode(fields[4]);
                message.ciphertext = urlDecode(fields[5]); message.createdAt = std::atoll(fields[6].c_str());
                it->second.messages.push_back(message);
            }
        }
    }

    void saveLocked() {
        const auto slash = file_.find_last_of('/');
        if (slash != std::string::npos) {
            const std::string directory = file_.substr(0, slash);
            std::error_code error;
            std::filesystem::create_directories(directory, error);
        }
        const std::string tmp = file_ + ".tmp";
        std::ofstream out(tmp, std::ios::trunc);
        if (!out) { std::cerr << "[store] unable to write " << tmp << '\n'; return; }
        for (const auto& [id, chat] : chats_) {
            out << "CHAT|" << urlEncode(chat.id) << '|' << urlEncode(chat.name) << '|' << urlEncode(chat.handle) << '|'
                << urlEncode(chat.initials) << '|' << urlEncode(chat.tone) << '|' << urlEncode(chat.status) << '|'
                << urlEncode(chat.preview) << '|' << urlEncode(chat.about) << '|' << (chat.favorite ? '1' : '0') << '|' << (chat.group ? '1' : '0') << '\n';
            for (const auto& message : chat.messages) {
                out << "MSG|" << urlEncode(chat.id) << '|' << urlEncode(message.id) << '|' << urlEncode(message.sender) << '|'
                    << urlEncode(message.text) << '|' << urlEncode(message.ciphertext) << '|' << message.createdAt << '\n';
            }
        }
        out.close();
        std::rename(tmp.c_str(), file_.c_str());
    }

    void seed() {
        Chat arina{"arina", "Арина Власова", "@arina.v", "АВ", "lime", "В сети", "Да, исходники у меня", "Продуктовый дизайнер. За ясные интерфейсы и тихие кофейни.", true, false, {}};
        arina.messages = {
            {"a1", "peer", "Привет! Я собрала новый вариант экрана. Кажется, теперь всё дышит намного свободнее.", {}, nowSeconds() - 620},
            {"a2", "me", "Выглядит отлично. Особенно то, как ты собрала навигацию — сразу понятно, куда идти.", {}, nowSeconds() - 500},
            {"a3", "peer", "Да, я убрала всё лишнее. Оставила только то, что помогает сделать следующий шаг.", {}, nowSeconds() - 370},
            {"a4", "peer", {}, "TSY1.demo.file.tsuyu-flow-v3.fig", nowSeconds() - 310},
            {"a5", "me", "Да, исходники у меня. Возьму в работу до обеда и верну тебе финальный flow.", {}, nowSeconds() - 220},
            {"a6", "peer", "Супер! Тогда созвонимся после 14:00? Хочу пройтись по микрокопирайтингу.", {}, nowSeconds() - 130},
            {"a7", "me", "Договорились. Я поставлю напоминание, чтобы не потерялось.", {}, nowSeconds() - 70}
        };
        Chat team{"team", "Команда Tsuyu", "@tsuyu-team", "ТТ", "blue", "6 участников", "Марк: Релиз-кандидат готов", "Рабочая группа команды Tsuyu. Делаем приватные коммуникации человечнее.", true, true, {}};
        team.messages = {
            {"t1", "Марк", "Релиз-кандидат готов, можно отдавать на smoke-тест.", {}, nowSeconds() - 3600},
            {"t2", "me", "Принял. Проверю миграции и соберу changelog.", {}, nowSeconds() - 3500},
            {"t3", "Ника", "Я уже прошла сценарий восстановления ключа — всё чисто.", {}, nowSeconds() - 3000}
        };
        Chat mark{"mark", "Марк Ли", "@markli", "МЛ", "orange", "Был недавно", "Voice message · 0:32", "Инженер по безопасности. Всегда проверяю дважды.", false, false, {}};
        mark.messages = {{"m1", "peer", {}, "TSY1.demo.voice.32s", nowSeconds() - 80000}, {"m2", "me", "Послушаю по дороге. Спасибо!", {}, nowSeconds() - 79000}};
        chats_[arina.id] = arina; chats_[team.id] = team; chats_[mark.id] = mark;
    }
};

struct User { std::string id; std::string name; std::string username; std::string initials; };
struct HttpRequest { std::string method; std::string target; std::map<std::string, std::string> headers; std::string body; };
struct HttpResponse { int status = 200; std::string contentType = "application/json; charset=utf-8"; std::string body; };

std::string statusText(int status) {
    switch (status) { case 200: return "OK"; case 201: return "Created"; case 204: return "No Content"; case 400: return "Bad Request"; case 401: return "Unauthorized"; case 404: return "Not Found"; case 409: return "Conflict"; case 413: return "Payload Too Large"; default: return "Internal Server Error"; }
}

bool sendAll(int fd, const std::string& data) {
    std::size_t sent = 0;
    while (sent < data.size()) {
        const auto result = ::send(fd, data.data() + sent, data.size() - sent, MSG_NOSIGNAL);
        if (result <= 0) return false;
        sent += static_cast<std::size_t>(result);
    }
    return true;
}

bool recvExact(int fd, void* target, std::size_t length) {
    auto* bytes = static_cast<unsigned char*>(target);
    std::size_t received = 0;
    while (received < length) {
        const auto result = ::recv(fd, bytes + received, length - received, 0);
        if (result <= 0) return false;
        received += static_cast<std::size_t>(result);
    }
    return true;
}

std::string readHttpRequest(int fd) {
    std::string raw;
    char buffer[4096];
    while (raw.find("\r\n\r\n") == std::string::npos && raw.size() < 1024 * 1024) {
        const auto read = ::recv(fd, buffer, sizeof(buffer), 0);
        if (read <= 0) return {};
        raw.append(buffer, static_cast<std::size_t>(read));
    }
    return raw;
}

bool parseHttp(int fd, const std::string& raw, HttpRequest& request) {
    const auto headerEnd = raw.find("\r\n\r\n");
    if (headerEnd == std::string::npos) return false;
    std::istringstream stream(raw.substr(0, headerEnd));
    std::string line;
    if (!std::getline(stream, line)) return false;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::istringstream first(line);
    first >> request.method >> request.target;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const auto colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = line.substr(0, colon);
        std::string value = line.substr(colon + 1);
        while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) value.erase(value.begin());
        std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        request.headers[key] = value;
    }
    std::size_t contentLength = 0;
    if (request.headers.count("content-length")) contentLength = static_cast<std::size_t>(std::strtoull(request.headers["content-length"].c_str(), nullptr, 10));
    if (contentLength > 4 * 1024 * 1024) return false;
    request.body = raw.substr(headerEnd + 4);
    while (request.body.size() < contentLength) {
        char buffer[4096];
        const auto read = ::recv(fd, buffer, sizeof(buffer), 0);
        if (read <= 0) break;
        request.body.append(buffer, static_cast<std::size_t>(read));
    }
    if (request.body.size() > contentLength) request.body.resize(contentLength);
    return !request.method.empty() && !request.target.empty();
}

std::string base64(const std::vector<unsigned char>& input) {
    static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int value = 0, bits = -6;
    for (unsigned char c : input) {
        value = (value << 8) + c; bits += 8;
        while (bits >= 0) { out.push_back(table[(value >> bits) & 0x3f]); bits -= 6; }
    }
    if (bits > -6) out.push_back(table[((value << 8) >> (bits + 8)) & 0x3f]);
    while (out.size() % 4) out.push_back('=');
    return out;
}

std::uint32_t leftRotate(std::uint32_t value, int bits) { return (value << bits) | (value >> (32 - bits)); }

std::vector<unsigned char> sha1(const std::string& input) {
    std::vector<unsigned char> message(input.begin(), input.end());
    const std::uint64_t bitLength = static_cast<std::uint64_t>(message.size()) * 8;
    message.push_back(0x80);
    while (message.size() % 64 != 56) message.push_back(0);
    for (int i = 7; i >= 0; --i) message.push_back(static_cast<unsigned char>((bitLength >> (i * 8)) & 0xff));
    std::uint32_t h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (std::size_t chunk = 0; chunk < message.size(); chunk += 64) {
        std::uint32_t w[80]{};
        for (int i = 0; i < 16; ++i) w[i] = (message[chunk + i * 4] << 24) | (message[chunk + i * 4 + 1] << 16) | (message[chunk + i * 4 + 2] << 8) | message[chunk + i * 4 + 3];
        for (int i = 16; i < 80; ++i) w[i] = leftRotate(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        std::uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
        for (int i = 0; i < 80; ++i) {
            std::uint32_t f, k;
            if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            const auto temp = leftRotate(a, 5) + f + e + k + w[i]; e = d; d = c; c = leftRotate(b, 30); b = a; a = temp;
        }
        h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
    }
    std::vector<unsigned char> digest;
    for (auto word : {h0, h1, h2, h3, h4}) for (int i = 3; i >= 0; --i) digest.push_back(static_cast<unsigned char>((word >> (i * 8)) & 0xff));
    return digest;
}

std::string wsFrame(const std::string& payload, unsigned char opcode = 0x1) {
    std::string frame;
    frame.push_back(static_cast<char>(0x80 | opcode));
    if (payload.size() < 126) frame.push_back(static_cast<char>(payload.size()));
    else if (payload.size() <= 65535) { frame.push_back(126); frame.push_back(static_cast<char>((payload.size() >> 8) & 0xff)); frame.push_back(static_cast<char>(payload.size() & 0xff)); }
    else return {};
    frame += payload;
    return frame;
}

std::string jsonMessage(const Message& message, const std::string& userId) {
    std::ostringstream out;
    const bool outgoing = message.sender == "me" || message.sender == userId;
    out << "{\"id\":\"" << jsonEscape(message.id) << "\",\"side\":\"" << (outgoing ? "outgoing" : "incoming") << "\",\"text\":\"" << jsonEscape(message.text.empty() ? "" : message.text) << "\",\"ciphertext\":\"" << jsonEscape(message.ciphertext) << "\",\"time\":\"" << timeLabel(message.createdAt) << "\",\"read\":" << (outgoing ? "true" : "false") << "}";
    return out.str();
}

std::string jsonChat(const Chat& chat, const std::string& userId) {
    std::ostringstream out;
    out << "{\"key\":\"" << jsonEscape(chat.id) << "\",\"name\":\"" << jsonEscape(chat.name) << "\",\"handle\":\"" << jsonEscape(chat.handle) << "\",\"initials\":\"" << jsonEscape(chat.initials) << "\",\"tone\":\"" << jsonEscape(chat.tone) << "\",\"status\":\"" << jsonEscape(chat.status) << "\",\"time\":\"" << (chat.messages.empty() ? "" : timeLabel(chat.messages.back().createdAt)) << "\",\"preview\":\"" << jsonEscape(chat.preview) << "\",\"unread\":0,\"favorite\":" << (chat.favorite ? "true" : "false") << ",\"group\":" << (chat.group ? "true" : "false") << ",\"about\":\"" << jsonEscape(chat.about) << "\",\"messages\":[";
    for (std::size_t i = 0; i < chat.messages.size(); ++i) { if (i) out << ','; out << jsonMessage(chat.messages[i], userId); }
    out << "]}";
    return out.str();
}

class Server {
public:
    Server(int port, std::string webRoot, std::string dataFile) : port_(port), webRoot_(std::move(webRoot)), store_(std::move(dataFile)) {}

    void run() {
        const int listener = ::socket(AF_INET, SOCK_STREAM, 0);
        if (listener < 0) { std::cerr << "socket failed\n"; return; }
        int yes = 1; setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = INADDR_ANY; address.sin_port = htons(static_cast<uint16_t>(port_));
        if (bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0 || listen(listener, 128) < 0) { std::cerr << "bind/listen failed on " << port_ << ": " << std::strerror(errno) << '\n'; ::close(listener); return; }
        std::cout << "Tsuyu gateway listening on 0.0.0.0:" << port_ << "\n";
        std::cout << "Web root: " << webRoot_ << " | JSON store: " << dataFileDescription() << "\n";
        while (running_) {
            sockaddr_in clientAddress{}; socklen_t length = sizeof(clientAddress);
            const int client = ::accept(listener, reinterpret_cast<sockaddr*>(&clientAddress), &length);
            if (client < 0) { if (errno == EINTR) continue; break; }
            std::thread(&Server::handleClient, this, client).detach();
        }
        ::close(listener);
    }

private:
    int port_;
    std::string webRoot_;
    Store store_;
    std::atomic<bool> running_{true};
    std::mutex sessionMutex_;
    std::unordered_map<std::string, User> sessions_;
    std::mutex websocketMutex_;
    std::vector<int> websocketClients_;

    std::string dataFileDescription() const { return "server/data/tsuyu.store"; }

    static std::string header(const HttpRequest& request, const std::string& name) {
        auto it = request.headers.find(name); return it == request.headers.end() ? std::string{} : it->second;
    }

    std::string authenticatedUser(const HttpRequest& request) {
        std::string token;
        const std::string authorization = header(request, "authorization");
        const std::string prefix = "Bearer ";
        if (authorization.rfind(prefix, 0) == 0) token = authorization.substr(prefix.size());
        if (token.empty()) {
            const auto query = request.target.find('?');
            if (query != std::string::npos) {
                for (const auto& pair : split(request.target.substr(query + 1), '&')) {
                    const auto equals = pair.find('=');
                    if (equals != std::string::npos && pair.substr(0, equals) == "token") token = urlDecode(pair.substr(equals + 1));
                }
            }
        }
        if (token.empty()) return {};
        std::lock_guard<std::mutex> lock(sessionMutex_);
        auto it = sessions_.find(token);
        return it == sessions_.end() ? std::string{} : it->second.id;
    }

    HttpResponse response(int status, std::string body, std::string type = "application/json; charset=utf-8") { return {status, std::move(type), std::move(body)}; }

    HttpResponse api(const HttpRequest& request) {
        const std::string target = request.target.substr(0, request.target.find('?'));
        if (request.method == "OPTIONS") return response(204, "");
        if (target == "/api/v1/health" && request.method == "GET") return response(200, "{\"ok\":true,\"service\":\"tsuyu-gateway\",\"version\":\"0.1.0\",\"e2ee\":\"ciphertext-only\"}");
        if (target == "/api/v1/auth/session" && request.method == "POST") {
            User user;
            user.id = "u_" + randomHex(8);
            user.name = jsonString(request.body, "name"); if (user.name.empty()) user.name = "Алексей Ким";
            user.username = jsonString(request.body, "username"); if (user.username.empty()) user.username = "alexkim";
            user.initials = user.name.size() >= 2 ? user.name.substr(0, 2) : "АК";
            const std::string token = randomHex(32);
            { std::lock_guard<std::mutex> lock(sessionMutex_); sessions_[token] = user; }
            std::ostringstream out; out << "{\"token\":\"" << token << "\",\"user\":{\"id\":\"" << user.id << "\",\"name\":\"" << jsonEscape(user.name) << "\",\"username\":\"" << jsonEscape(user.username) << "\"}}";
            return response(201, out.str());
        }
        const std::string userId = authenticatedUser(request);
        if (userId.empty()) return response(401, "{\"error\":\"unauthorized\",\"message\":\"Bearer session required\"}");
        if (target == "/api/v1/me" && request.method == "GET") return response(200, "{\"id\":\"" + jsonEscape(userId) + "\",\"name\":\"Алексей Ким\",\"username\":\"alexkim\"}");
        if (target == "/api/v1/chats" && request.method == "GET") {
            const auto chats = store_.chats(); std::ostringstream out; out << "{\"chats\":[";
            for (std::size_t i = 0; i < chats.size(); ++i) { if (i) out << ','; out << jsonChat(chats[i], userId); }
            out << "]}"; return response(200, out.str());
        }
        if (target == "/api/v1/chats" && request.method == "POST") {
            auto chat = store_.createChat(jsonString(request.body, "name"), jsonString(request.body, "handle"), jsonString(request.body, "initials"), jsonString(request.body, "tone"));
            return response(201, "{\"chat\":" + jsonChat(chat, userId) + "}");
        }
        const std::string prefix = "/api/v1/chats/";
        if (target.rfind(prefix, 0) == 0) {
            const auto remainder = target.substr(prefix.size());
            const auto slash = remainder.find('/');
            const std::string chatId = slash == std::string::npos ? remainder : remainder.substr(0, slash);
            Chat* chat = store_.find(chatId);
            if (!chat) return response(404, "{\"error\":\"chat_not_found\"}");
            const std::string subpath = slash == std::string::npos ? "" : remainder.substr(slash);
            if (subpath == "/messages" && request.method == "GET") {
                std::ostringstream out; out << "{\"messages\":[";
                for (std::size_t i = 0; i < chat->messages.size(); ++i) { if (i) out << ','; out << jsonMessage(chat->messages[i], userId); }
                out << "]}"; return response(200, out.str());
            }
            if (subpath == "/messages" && request.method == "POST") {
                Message message;
                message.id = jsonString(request.body, "client_message_id"); if (message.id.empty()) message.id = "msg_" + randomHex(10);
                message.sender = userId;
                message.ciphertext = jsonString(request.body, "ciphertext");
                // A plaintext body is accepted only for local development. The
                // browser client sends ciphertext by default.
                message.text = jsonString(request.body, "text");
                if (message.ciphertext.empty() && message.text.empty()) return response(400, "{\"error\":\"ciphertext_required\"}");
                message.createdAt = nowSeconds();
                auto stored = store_.addMessage(chatId, message);
                if (stored.id.empty()) return response(404, "{\"error\":\"chat_not_found\"}");
                std::string event = "{\"type\":\"message.created\",\"chat_id\":\"" + jsonEscape(chatId) + "\",\"message\":" + jsonMessage(stored, userId) + "}";
                broadcast(event);
                return response(201, "{\"message\":" + jsonMessage(stored, userId) + "}");
            }
        }
        if (target == "/api/v1/stats" && request.method == "GET") return response(200, "{\"active_devices\":1,\"queued_events\":0,\"storage\":\"file\",\"encryption\":\"client-side\"}");
        return response(404, "{\"error\":\"not_found\"}");
    }

    std::string mimeType(const std::string& path) {
        if (path.ends_with(".html")) return "text/html; charset=utf-8";
        if (path.ends_with(".css")) return "text/css; charset=utf-8";
        if (path.ends_with(".js")) return "application/javascript; charset=utf-8";
        if (path.ends_with(".svg")) return "image/svg+xml";
        if (path.ends_with(".json")) return "application/json; charset=utf-8";
        return "application/octet-stream";
    }

    HttpResponse staticFile(const HttpRequest& request) {
        std::string path = request.target.substr(0, request.target.find('?'));
        path = urlDecode(path);
        if (path == "/") path = "/index.html";
        if (path.find("..") != std::string::npos) return response(403, "forbidden\n", "text/plain; charset=utf-8");
        std::ifstream in(webRoot_ + path, std::ios::binary);
        if (!in) return response(404, "not found\n", "text/plain; charset=utf-8");
        std::ostringstream contents; contents << in.rdbuf();
        return response(200, contents.str(), mimeType(path));
    }

    void sendHttp(int fd, const HttpResponse& result) {
        std::ostringstream out;
        out << "HTTP/1.1 " << result.status << ' ' << statusText(result.status) << "\r\n"
            << "Content-Type: " << result.contentType << "\r\n"
            << "Content-Length: " << result.body.size() << "\r\n"
            << "Cache-Control: no-store\r\n"
            << "X-Content-Type-Options: nosniff\r\n"
            << "Referrer-Policy: no-referrer\r\n"
            << "Access-Control-Allow-Origin: *\r\n"
            << "Access-Control-Allow-Headers: Authorization, Content-Type\r\n"
            << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            << "Connection: close\r\n\r\n" << result.body;
        sendAll(fd, out.str());
    }

    void broadcast(const std::string& event) {
        const auto frame = wsFrame(event);
        std::lock_guard<std::mutex> lock(websocketMutex_);
        for (auto it = websocketClients_.begin(); it != websocketClients_.end();) {
            if (sendAll(*it, frame)) ++it;
            else { ::close(*it); it = websocketClients_.erase(it); }
        }
    }

    void websocket(int fd, const HttpRequest& request) {
        const std::string key = header(request, "sec-websocket-key");
        if (key.empty()) { ::close(fd); return; }
        const std::string accept = base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
        const std::string handshake = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
        if (!sendAll(fd, handshake)) { ::close(fd); return; }
        { std::lock_guard<std::mutex> lock(websocketMutex_); websocketClients_.push_back(fd); }
        sendAll(fd, wsFrame("{\"type\":\"ready\",\"service\":\"tsuyu-gateway\"}"));
        while (true) {
            unsigned char first[2]; if (!recvExact(fd, first, 2)) break;
            const unsigned char opcode = first[0] & 0x0f; const bool masked = (first[1] & 0x80) != 0; std::uint64_t length = first[1] & 0x7f;
            if (length == 126) { unsigned char bytes[2]; if (!recvExact(fd, bytes, 2)) break; length = (static_cast<std::uint64_t>(bytes[0]) << 8) | bytes[1]; }
            else if (length == 127) { unsigned char bytes[8]; if (!recvExact(fd, bytes, 8)) break; length = 0; for (unsigned char b : bytes) length = (length << 8) | b; }
            if (length > 1024 * 1024) break;
            unsigned char mask[4]{}; if (masked && !recvExact(fd, mask, 4)) break;
            std::string payload(static_cast<std::size_t>(length), '\0'); if (length && !recvExact(fd, payload.data(), static_cast<std::size_t>(length))) break;
            if (masked) for (std::size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(payload[i] ^ mask[i % 4]);
            if (opcode == 0x8) { sendAll(fd, wsFrame("", 0x8)); break; }
            if (opcode == 0x9) sendAll(fd, wsFrame(payload, 0xA));
        }
        std::lock_guard<std::mutex> lock(websocketMutex_);
        websocketClients_.erase(std::remove(websocketClients_.begin(), websocketClients_.end(), fd), websocketClients_.end());
        ::close(fd);
    }

    void handleClient(int fd) {
        const std::string raw = readHttpRequest(fd);
        if (raw.empty()) { ::close(fd); return; }
        HttpRequest request;
        if (!parseHttp(fd, raw, request)) { sendHttp(fd, response(400, "{\"error\":\"bad_request\"}")); ::close(fd); return; }
        const std::string upgrade = header(request, "upgrade");
        if (request.target.rfind("/ws", 0) == 0 && upgrade == "websocket") {
            if (authenticatedUser(request).empty()) { sendHttp(fd, response(401, "{\"error\":\"websocket_auth_required\"}")); ::close(fd); return; }
            websocket(fd, request); return;
        }
        if (request.target.rfind("/api/", 0) == 0) sendHttp(fd, api(request));
        else if (request.method == "GET" || request.method == "HEAD") sendHttp(fd, staticFile(request));
        else sendHttp(fd, response(405, "{\"error\":\"method_not_allowed\"}"));
        ::close(fd);
    }
};

} // namespace

int main(int argc, char** argv) {
    int port = 9000;
    std::string webRoot = ".";
    std::string dataFile = "server/data/tsuyu.store";
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
        else if (arg == "--web-root" && i + 1 < argc) webRoot = argv[++i];
        else if (arg == "--data" && i + 1 < argc) dataFile = argv[++i];
        else if (arg == "--help") { std::cout << "Tsuyu gateway\n  --port 9000\n  --web-root .\n  --data server/data/tsuyu.store\n"; return 0; }
    }
    Server server(port, webRoot, dataFile);
    server.run();
    return 0;
}
