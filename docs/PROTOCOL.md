# Tsuyu Secure Messaging Protocol v0.1

Статус: **design draft, не production и не audited**.

Текущий web-клиент использует локальный AES-GCM ключ только для smoke-теста ciphertext transport; это не multi-device session и не замена TSY-1. Production-клиент обязан перейти на device bundles и ratchet flow ниже.

Tsuyu определяет orchestration и wire format поверх проверенных криптографических primitives. Это принципиально: собственный «математический шифр» нельзя объявлять самым сильным без многолетнего публичного анализа. Tsuyu не заменяет Signal Protocol; до аудита используйте реализацию Double Ratchet из libsodium/официально проверенного компонента, а не самописную криптографию.

## Цели

- содержимое сообщения не читается relay-сервером;
- forward secrecy: компрометация текущего состояния не раскрывает прошлые сообщения;
- post-compromise recovery после успешного обмена новыми DH-ключами;
- асинхронная доставка на несколько устройств;
- защита от replay, подмены устройства и downgrade;
- быстрый путь для текста и потоковый путь для вложений;
- возможность аудита и независимой совместимости клиентов.

## Криптографические компоненты

Рекомендуемый профиль `TSY-1`:

| Задача | Primitive | Комментарий |
| --- | --- | --- |
| identity key | Ed25519 | подпись pre-key bundle и safety number |
| key agreement | X25519 | ephemeral/one-time/pre-key DH |
| KDF | HKDF-SHA-256 | отдельные domain separation labels |
| message AEAD | ChaCha20-Poly1305 | nonce не переиспользуется |
| file AEAD | XChaCha20-Poly1305 | отдельный file key и chunk nonces |
| hash | SHA-256 | fingerprint и content commitment |

Для C++ используйте audited `libsodium` или эквивалентный провайдер с pinned version. Не меняйте primitive самостоятельно и не добавляйте «ещё один слой шифрования» без threat-model и аудита.

## Устройства и initial key agreement

У каждого устройства есть:

```text
identity_key       Ed25519 signing key, хранится в OS secure storage
signed_prekey      X25519 public key + Ed25519 signature
one_time_prekeys   набор одноразовых X25519 public keys
device_id          случайный 128-bit identifier
capabilities       версия протокола и поддерживаемые ciphersuites
```

При начале диалога Alice загружает bundle Bob и проверяет подпись signed pre-key через identity key. X3DH-подобный initial secret строится из доступных DH-комбинаций. В заголовок не попадают plaintext usernames или телефонные номера.

Из shared secret через HKDF с label `tsuyu/tsy-1/session/v1` выводятся `root_key`, `send_chain_key` и `receive_chain_key`. Каждый device pair получает отдельную сессию. Для группы сервер передаёт encrypted sender-key envelopes каждому устройству, а не общий открытый ключ.

## Double Ratchet envelope

Сервер видит только envelope и маршрутизационные поля:

```json
{
  "version": 1,
  "suite": "TSY-1",
  "event_id": "uuid-v4",
  "conversation_id": "opaque-id",
  "sender_device_id": "opaque-device-id",
  "recipient_device_id": "opaque-device-id",
  "ratchet": {
    "dh_public": "base64url(32 bytes)",
    "pn": 12,
    "n": 47
  },
  "header": "base64url(canonical-aad-header)",
  "nonce": "base64url(24 bytes)",
  "ciphertext": "base64url(payload + auth tag)",
  "created_at": 1788507720
}
```

`header` канонизируется и входит в AEAD associated data. `conversation_id`, `sender_device_id`, `recipient_device_id`, `version`, `suite`, `pn`, `n` и `event_id` нельзя менять после шифрования. Клиент:

1. проверяет версию, suite и размер полей;
2. отклоняет event id, уже находящийся в replay cache;
3. обрабатывает новый ratchet public key и выводит receiving chain;
4. выводит message key ровно один раз;
5. проверяет AEAD tag и только потом отдаёт plaintext UI;
6. уничтожает использованный message key после подтверждённой расшифровки.

Окно пропущенных сообщений ограничено и настраивается политикой устройства. Нельзя принимать бесконечный `n` или хранить skipped keys без TTL и лимита памяти.

## Payload

Plaintext payload шифруется до отправки:

```json
{
  "kind": "text",
  "client_message_id": "uuid-v4",
  "body": "...",
  "reply_to": null,
  "attachments": [],
  "expires_in": null,
  "created_at": 1788507720
}
```

Поддерживаемые `kind`: `text`, `reaction`, `edit`, `delete`, `receipt`, `typing`, `call_invite`, `file_manifest`. Typing и presence допускают отдельную ephemeral policy и не должны раскрывать содержимое сообщения.

Редактирование и удаление — это подписанные логические события, а не изменение уже доставленного ciphertext. Сервер может удалить blob и metadata по retention policy, но не может гарантировать удаление копий на устройствах собеседника.

## Вложения

Файл режется на чанки фиксированного размера. Клиент случайно генерирует `file_key`, вычисляет hash каждого ciphertext chunk и encrypts manifest в обычном message payload:

```json
{
  "object_id": "opaque-id",
  "size": 18243512,
  "mime": "application/octet-stream",
  "chunk_size": 1048576,
  "cipher_hash": "sha256:...",
  "encrypted_file_key": "..."
}
```

Имя файла и MIME могут быть чувствительными: если UX позволяет, шифруйте и их в manifest. Signed URLs короткоживущие и привязаны к authenticated device.

## Safety number и доверие

Safety number выводится из identity public keys всех устройств в детерминированном порядке. QR/строка сверяется вне канала. При добавлении устройства safety number меняется, старый verified state сбрасывается и все участники получают заметное предупреждение. UI Tsuyu показывает это в окне «Проверка безопасности».

Резервное копирование identity keys должно быть opt-in, end-to-end encrypted и защищено recovery key. Push notifications содержат opaque wake-up token, но не plaintext message.

## Серверные гарантии и ограничения

Relay хранит ciphertext, delivery queue, минимальные ACL и opaque identifiers. Он может видеть timing, IP, размер envelope и факт доставки; metadata privacy требует отдельного padding/mix design и не обещается этим draft.

Сервер обязан:

- проверять auth token и device binding;
- применять size/rate limits и replay protection;
- сохранять порядок только в рамках conversation queue;
- не логировать `ciphertext` и access tokens в plaintext;
- выдавать одноразовые upload/download tickets;
- поддерживать backpressure и idempotency по `client_message_id`.

## Угрозы, которые надо закрыть до релиза

- malicious server и compromised relay;
- потерянный/украденный телефон;
- восстановление после backup;
- key transparency и незаметная замена bundle;
- multi-device consistency;
- spam, account takeover, SIM swap;
- traffic analysis, contact discovery и metadata leakage;
- malicious attachments и parser vulnerabilities;
- downgrade между версиями клиента;
- скриншоты и копирование plaintext на endpoint.

## План до production

1. зафиксировать threat model и API compatibility policy;
2. написать reference implementation и test vectors для каждого шага;
3. использовать только audited library bindings;
4. провести property tests, fuzzing envelope/parser и interop tests для C++/mobile/web;
5. заказать внешний криптографический и application-security аудит;
6. запустить staged rollout, key transparency log и incident response;
7. опубликовать security contact, disclosure policy и changelog протокола.
