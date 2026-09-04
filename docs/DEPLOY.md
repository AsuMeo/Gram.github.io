# Деплой Tsuyu

Документ описывает два режима:

1. **UI-only** — этот репозиторий как статический клиент, подходит для GitHub Pages, демо и дизайна.
2. **Production** — статический клиент + C++ API/WebSocket gateway за одним HTTPS-доменом.

## 1. Быстрый запуск

```bash
git clone https://github.com/KamiSakyy/Gram.github.io.git tsuyu
cd tsuyu
python3 -m http.server 8080
```

Откройте `http://127.0.0.1:8080`. Для теста в локальной сети привяжите сервер к `0.0.0.0`:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

Это только статический UI. Он показывает локальные демо-данные и не должен использоваться как сервер сообщений.

## 2. Nginx для UI

Пример Ubuntu/Debian:

```bash
sudo apt update
sudo apt install nginx
sudo mkdir -p /var/www/tsuyu
sudo cp -r ./* /var/www/tsuyu/
sudo chown -R www-data:www-data /var/www/tsuyu
```

`/etc/nginx/sites-available/tsuyu`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name chat.example.com;

    root /var/www/tsuyu;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # API и WebSocket gateway подключаются к тому же origin.
    location /api/ {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss://chat.example.com https://chat.example.com; font-src 'self'; frame-ancestors 'none'" always;
}
```

Активируйте сайт и перезагрузите Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/tsuyu /etc/nginx/sites-enabled/tsuyu
sudo nginx -t
sudo systemctl reload nginx
```

## 3. HTTPS обязателен

WebSocket в production должен работать через `wss://`, а медиа API — только в secure context. Получите сертификат, например через Certbot:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d chat.example.com
```

Проверьте, что автоматически перенаправляется HTTP → HTTPS. Не добавляйте в CSP wildcard `*` и не разрешайте CORS для всех доменов.

## 4. Подключение C++ backend

Gateway должен слушать только loopback или private network, например `127.0.0.1:9000`, а наружу публиковаться через Nginx. Базовые endpoints:

```text
POST   /api/v1/auth/session
GET    /api/v1/me
GET    /api/v1/chats
POST   /api/v1/chats
GET    /api/v1/chats/{id}/messages?before={cursor}
POST   /api/v1/media/upload-ticket
GET    /api/v1/devices
POST   /api/v1/safety-number/verify
WS     /ws/v1
```

События WebSocket должны иметь envelope с `event_id`, `conversation_id`, `sender_device_id`, `server_sequence` и зашифрованным payload. Сервер проверяет авторизацию, replay window и лимиты, но не расшифровывает `payload`. Формат и порядок ratchet-операций описаны в [PROTOCOL.md](PROTOCOL.md).

## 5. Object storage для вложений

1. Клиент просит у API одноразовый signed upload URL.
2. Клиент шифрует файл на устройстве отдельным случайным DEK.
3. Ciphertext загружается напрямую в S3-compatible storage.
4. В E2EE-сообщение попадает только object id, nonce, hash и зашифрованный DEK.
5. Gateway выдаёт временный signed download URL после проверки прав.

Храните object storage приватным. Серверные логи не должны содержать plaintext filenames, message bodies или ключи.

## 6. Минимальная эксплуатация

- база данных и очереди находятся в private subnet;
- включены регулярные зашифрованные backup и проверка восстановления;
- NTP синхронизирован на всех узлах;
- лимиты: размер сообщения, вложения, частота auth и WebSocket connections;
- секреты передаются через secret manager, а не через git и `.env` в репозитории;
- метрики: delivery latency, reconnect rate, queue depth, auth failures, key verification events;
- алерты на всплески неудачных логинов, replay и rate-limit events;
- ротация TLS, database и push-provider credentials документирована отдельно.

## Проверка после деплоя

```bash
curl -I https://chat.example.com
curl -sS https://chat.example.com/ | grep -q "Tsuyu"
# проверить upgrade WebSocket через ваш staging-клиент
```

Не открывайте порт C++ gateway напрямую в интернет и не считайте наличие HTTPS заменой сквозному шифрованию.
