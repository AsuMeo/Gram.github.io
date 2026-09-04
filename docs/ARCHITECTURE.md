# Архитектура production Tsuyu

## Компоненты

```text
Web / iOS / Android / Desktop clients
             │ HTTPS + WSS
             ▼
C++20 Edge Gateway ─── Auth service ─── PostgreSQL (accounts, ACL, cursors)
        │
        ├── Delivery service ─── NATS/Redis Streams ─── per-device queues
        ├── Media ticket service ─── S3-compatible private storage
        └── Call signaling ─── WebRTC SFU (media remains SRTP/E2EE where supported)
```

### C++20 Edge Gateway

- standalone Asio или Boost.Asio;
- Beast/WebSocket для HTTP/1.1 и WSS;
- `fmt` и structured JSON logging без plaintext payload;
- `libsodium` для X25519/Ed25519/AEAD;
- coroutines (`co_await`) для I/O;
- bounded queues, connection backpressure и graceful shutdown;
- strict schema validation до постановки события в очередь.

Gateway не хранит ключи пользователей и не расшифровывает сообщения. Авторизация устройства — короткоживущий access token + rotating refresh token, привязанный к device key. Для каждого запроса нужны request id и idempotency key.

### Хранилища

PostgreSQL содержит только account metadata, conversation membership, encrypted device bundles, cursors и retention metadata. Redis/NATS нужен для ephemeral delivery и presence, не для долговременного ciphertext. Вложения — encrypted blobs в приватном object storage.

## Логические потоки

### Сообщение

1. Клиент выбирает device sessions и выполняет ratchet.
2. Plaintext attachment/file manifest шифруются локально.
3. Каждый device получает свой encrypted envelope.
4. Gateway валидирует envelope, сохраняет очередь и отвечает `accepted`.
5. Delivery service доставляет ciphertext по WSS или хранит до reconnect.
6. Получатель проверяет replay, AEAD и только затем показывает UI.
7. Receipts — отдельные encrypted events.

### Multi-device

Новое устройство получает bundle только после явного подтверждения существующим устройством или recovery key. Для каждого recipient device шифруется отдельный envelope. Выход устройства отзывает его prekeys и сбрасывает trust state.

### Звонок

Сигналинг проходит через WSS и содержит только encrypted call metadata/SDP envelope. Аудио и видео идут через WebRTC. Для групповых звонков нужен SFU с Insertable Streams или SFrame, если требуется сквозная защита медиаданных; TURN credentials короткоживущие.

## Security baseline

- TLS 1.3, HSTS, secure cookies где применимо;
- CSP без wildcard и без inline third-party scripts;
- Argon2id для парольного recovery material, никогда не хранить пароль;
- OS Keychain/Keystore на endpoint;
- constant-time сравнения для ключей и tokens;
- лимиты на JSON, WebSocket frame, upload, room size и fan-out;
- санитизация filename/MIME и изоляция preview parsers;
- SBOM, pinned dependency versions и reproducible CI builds;
- secrets manager, private subnets, encrypted backups;
- SAST, dependency scanning, DAST, fuzzing и внешний аудит.

## CI/CD чеклист

- `cmake --preset release` + warnings as errors;
- unit tests для ratchet state machine и canonical envelope;
- golden test vectors из `docs/PROTOCOL.md`;
- sanitizers: ASan, UBSan, TSan на staging;
- integration tests PostgreSQL/NATS/S3;
- WebSocket reconnect, offline queue, duplicate delivery и clock skew;
- canary deploy и миграции с rollback;
- не собирать и не публиковать секреты или реальные сообщения в CI logs.

## Что добавить в следующем production-спринте

1. C++ gateway и schema-generated DTOs.
2. Device registration + key transparency log.
3. Durable offline delivery и idempotent receipts.
4. Encrypted media upload/download.
5. WebRTC signaling + TURN/SFU.
6. Mobile secure storage и push wake-up.
7. Audit, pen-test, incident response и public security policy.
