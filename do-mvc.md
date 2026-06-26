# 📘 DO-MVC.md — Рефакторинг CipherTalk в MVC архитектуру

# DO-MVC.md — Рефакторинг CipherTalk в MVC архитектуру

## 🎯 Цель
Перевести монолитный код `server.js` в модульную MVC архитектуру для лучшей поддерживаемости, тестируемости и возможности замены компонентов.

---

## 📁 Структура проекта

```
ciphertalk-server/
├── src/
│   ├── config/
│   │   └── index.js              # Все конфиги в одном месте
│   ├── models/                    # Модели данных (слой данных)
│   │   ├── User.js
│   │   ├── Message.js
│   │   └── Session.js
│   ├── controllers/               # Контроллеры (обработка запросов)
│   │   ├── authController.js
│   │   ├── messageController.js
│   │   └── profileController.js
│   ├── services/                  # Сервисы (бизнес-логика)
│   │   ├── encryptionService.js   # 🔑 Можно заменить
│   │   ├── smsService.js          # 📱 Можно заменить
│   │   ├── websocketService.js    # 🔌 Можно заменить
│   │   └── presenceService.js     # 🟢 Статусы онлайн
│   ├── middleware/                # Промежуточные слои
│   │   ├── auth.js                # Проверка токена
│   │   └── upload.js              # Загрузка файлов
│   ├── routes/                    # Маршруты API
│   │   ├── authRoutes.js
│   │   ├── messageRoutes.js
│   │   └── profileRoutes.js
│   ├── db/                        # База данных
│   │   └── database.js
│   └── app.js                     # Точка входа
├── tests/                         # Тесты
│   ├── unit/
│   └── integration/
├── .env                           # Переменные окружения
├── package.json
└── server.js                      # Только запуск (2-3 строки)
```