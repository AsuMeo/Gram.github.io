# Tsuyu C++20 gateway

Рабочий dependency-free gateway для локального запуска и staging. Он не является заменой кластерному production backend, но это уже не mock: клиент реально подключается к HTTP API, создаёт сессию, загружает persisted chats, отправляет ciphertext и получает `message.created` через WebSocket.

## Требования

- Linux/macOS или WSL;
- `g++`/`clang++` с C++20;
- `make`;
- POSIX sockets.

## Запуск

Из корня репозитория:

```bash
make -C server
./server/tsuyu-server --port 9000 --web-root . --data server/data/tsuyu.store
```

Затем откройте `http://localhost:9000`. При первом запуске создаётся `server/data/tsuyu.store`; файл не должен попадать в git.

Из директории `server`:

```bash
make
make run
```

Параметры:

```text
--port 9000
--web-root .
--data server/data/tsuyu.store
--help
```

## API

```text
GET  /api/v1/health
POST /api/v1/auth/session     {"name":"...","username":"..."}
GET  /api/v1/me               Authorization: Bearer <token>
GET  /api/v1/chats            Authorization: Bearer <token>
POST /api/v1/chats            Authorization: Bearer <token>
GET  /api/v1/chats/{id}/messages
POST /api/v1/chats/{id}/messages {"client_message_id":"...","ciphertext":"TSY1..."}
WS   /ws?token=<token>
```

Сообщение хранится в `ciphertext`. Gateway не расшифровывает его и не требует plaintext. UI в secure context шифрует локальный текст AES-GCM для development transport; production client должен использовать device sessions и Double Ratchet из [протокола](../docs/PROTOCOL.md).

## Проверка

```bash
curl http://localhost:9000/api/v1/health
```

Для проверки realtime откройте два клиента с одним токеном или используйте любой WebSocket client. После POST сервер рассылает событие:

```json
{
  "type": "message.created",
  "chat_id": "arina",
  "message": { "id": "...", "ciphertext": "TSYU..." }
}
```

## Ограничения текущего gateway

- HTTP и WebSocket слушают plain TCP: TLS должен завершаться на Nginx/Caddy/Envoy;
- store — один локальный append/rewrite-файл, без кластерной блокировки;
- минимальный flat JSON parser предназначен только для маленьких API-команд;
- demo session service не заменяет account/password/passkey/2FA service;
- нет push delivery, media object storage и WebRTC SFU.

Перед интернет-запуском необходимо заменить эти компоненты и пройти security-аудит. Целевая схема находится в `docs/ARCHITECTURE.md`, production deployment — в `docs/DEPLOY.md`.
