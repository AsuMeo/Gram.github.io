# Gram Flow

Переосмысленный статический клиент для коротких видео на **Firebase Realtime Database**. Он разворачивается на GitHub Pages без сборщика и хранит исходник клипа как **прямую ссылку** в RTDB — никаких видеофайлов в репозитории и никаких прокси-серверов.

## Что изменено

- Полностью новый adaptive desktop/mobile-интерфейс: вертикальный flow, витрина тем и звуков, профиль, активность, studio, PWA-оболочка и клавиатурная навигация.
- Надёжный REST + SSE клиент RTDB с повторным подключением, таймаутами, ETag-транзакциями для счётчиков и локальной офлайн-очередью.
- Новая публикация сохраняет прямой URL именно в `videos/{clipId}/src` и одновременно пишет `user`, `desc`, `music`, `timestamp` — это совместимо со старой страницей.
- Есть read-only decoder для прежних полей c `MEOWAES256:`. Старые клипы из этой базы продолжают отображаться, а все новые записи — обычный читаемый JSON.
- Никаких фальшивых клиентских «админ-паролей», автоматического fullscreen или принудительного запрета выделения/контекстного меню.

Полный перечень UX, плеерных, RTDB и accessibility улучшений — в [`FEATURES.md`](FEATURES.md).

## Быстрый запуск

Это чистый static site. Для локальной проверки:

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```

Затем откройте `http://localhost:4173`.

GitHub Pages может обслуживать репозиторий без отдельной сборки: корневой `index.html` уже является entrypoint.

## Настройка RTDB

По умолчанию приложение использует существующую базу:

```text
https://meow-874ce-default-rtdb.europe-west1.firebasedatabase.app
```

Чтобы использовать другой проект, до `app.js` определите переменную:

```html
<script>
  window.GRAM_FLOW_RTDB_URL = "https://YOUR-PROJECT-default-rtdb.firebaseio.com";
</script>
```

или замените `databaseUrl` в начале `app.js`.

### Совместимая запись нового клипа

```json
{
  "src": "https://cdn.example.com/story.mp4",
  "user": "@creator",
  "desc": "Подпись #идея",
  "music": "Оригинальный звук · @creator",
  "timestamp": 1780000000000,
  "createdAt": 1780000000000,
  "authorId": "device_…",
  "tags": ["#идея"],
  "cover": "https://cdn.example.com/cover.jpg",
  "captions": "https://cdn.example.com/captions.vtt",
  "commentsEnabled": true,
  "loop": true,
  "visibility": "public",
  "schemaVersion": 2
}
```

Обязательным остаётся только `src`; остальное делает карточку богаче. Поля `user`, `desc`, `music` и `timestamp` оставлены намеренно: их понимает предыдущая версия клиента.

### Существующие пути

| Путь | Назначение |
| --- | --- |
| `/videos/{clipId}` | Источники клипов и метаданные; прямой URL находится в `src` |
| `/likes/{clipId}` | Счётчик реакций |
| `/userLikes/{deviceId}/{clipId}` | Локально-устройственная отметка «нравится» |
| `/bookmarks/{clipId}` | Счётчик сохранений |
| `/userBookmarks/{deviceId}/{clipId}` | Сохранение пользователя |
| `/comments/{clipId}/{commentId}` | Комментарии |
| `/users/{deviceId}` | Имя, username, био и URL аватара |
| `/follows/{deviceId}/{authorId}` | Подписки |

## Production security — важно

Публичный REST-доступ к RTDB означает, что **любой пользователь может попытаться записать данные напрямую**. Красивый frontend не является механизмом авторизации. Старый browser-side AES-ключ также не является защитой: ключ уже находился в клиенте.

Перед production-релизом обязательно:

1. Подключите Firebase Authentication (анонимный, email, Google или собственный провайдер).
2. Замените device-id на `auth.uid` в записях автора.
3. Включите минимально необходимые Firebase Realtime Database Rules. Пример архитектуры находится в [`firebase-rules.production.example.json`](firebase-rules.production.example.json).
4. Сделайте Cloud Functions / серверный API для moderation, глобальных счётчиков, жалоб и выдачи подписанных URL.
5. Ограничьте CORS на CDN медиа, используйте HTTPS, не публикуйте private signed URLs и добавьте App Check.

Файл с правилами — **шаблон для аудита**, его нельзя включать вслепую, пока в клиент не интегрирован Firebase Auth.

## PWA и кэш

`sw.js` кэширует только shell приложения. Данные RTDB, SSE и медиа по внешним прямым URL сознательно не кэшируются service worker’ом: так лента не становится устаревшей и не заполняет хранилище устройства чужими роликами.

## Проверки

```bash
node --check app.js
node --check legacy-crypto.js
```

Приложение не требует `node_modules`, bundler’а или закрытых ключей.
