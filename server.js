/**
 * CipherTalk (КипяТок) Backend
 * Файл: server.js
 * Назначение: Главный сервер авторизации, маршрутизации, синхронизации мульти-девайсов 
 * и хранения зашифрованной переписки в папке 'server-data'.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Путь к папке для хранения зашифрованных историй переписок и данных пользователей
const DATA_DIR = path.join(__dirname, 'server-data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Хранение данных в памяти с дублированием на диск
const usersFile = path.join(DATA_DIR, 'users.json');
let users = new Map(); // userId -> user object

// Загрузка пользователей при старте
if (fs.existsSync(usersFile)) {
    try {
        const raw = fs.readFileSync(usersFile, 'utf8');
        const parsed = JSON.parse(raw);
        for (const u of parsed) {
            // Гарантируем наличие массива чатов для каждого пользователя
            if (!u.chats) u.chats = [];
            users.set(u.id, u);
        }
    } catch (e) {
        console.error("Ошибка чтения пользователей с диска:", e);
    }
}

function saveUsersToDisk() {
    try {
        const list = Array.from(users.values());
        fs.writeFileSync(usersFile, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.error("Ошибка сохранения пользователей на диск:", e);
    }
}

const verificationCodes = new Map(); // phone -> code
const sessions = new Map();         // token -> userId

// Мульти-девайсы: храним массив соединений для каждого userId
// userId -> Set of WebSockets
const activeConnections = new Map(); 

// --- REST API ЭНДПОИНТЫ ---

/**
 * 1. Запрос кода авторизации (Эмуляция SMS через консоль)
 */
app.post('/api/auth/request-code', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Номер телефона обязателен' });
    }

    // Очистка номера телефона от лишних символов
    const cleanPhone = phone.replace(/[\s()\-+]/g, '');

    // Генерация 4-значного кода
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    verificationCodes.set(cleanPhone, code);

    // Вывод кода в лог сервера по вашему формату
    console.log(`\n========================================`);
    console.log(`+${cleanPhone} - код: ${code}`);
    console.log(`========================================\n`);

    res.json({ success: true, message: 'Код отправлен (проверьте консоль сервера)' });
});

/**
 * 2. Подтверждение кода и авторизация
 */
app.post('/api/auth/verify-code', (req, res) => {
    const { phone, code, name } = req.body;
    if (!phone || !code) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const cleanPhone = phone.replace(/[\s()\-+]/g, '');
    const savedCode = verificationCodes.get(cleanPhone);

    if (savedCode !== code) {
        return res.status(400).json({ error: 'Неверный код подтверждения' });
    }

    // Удаляем код после успешной авторизации
    verificationCodes.delete(cleanPhone);

    // Поиск или создание пользователя
    let userId = null;
    for (const [id, user] of users.entries()) {
        if (user.phone.replace(/[\s()\-+]/g, '') === cleanPhone) {
            userId = id;
            break;
        }
    }

    if (!userId) {
        userId = 'usr_' + crypto.randomBytes(8).toString('hex');
        const newUser = {
            id: userId,
            phone: '+' + cleanPhone,
            name: name || `Пользователь ${cleanPhone.slice(-4)}`,
            username: '', 
            bio: 'Привет! Я использую КипяТок.',
            avatarColor: 'bg-blue-600',
            chats: [], // Список IDs пользователей, с которыми открыты чаты
            status: 'online'
        };
        users.set(userId, newUser);
        saveUsersToDisk();
    }

    // Генерация сессионного токена
    const token = 'tok_' + crypto.randomBytes(32).toString('hex');
    sessions.set(token, userId);

    res.json({
        success: true,
        token,
        user: users.get(userId)
    });
});

/**
 * 3. Поиск пользователя по номеру телефона, имени или username
 * Доступен для глобального поиска
 */
app.get('/api/users/search', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет авторизации' });

    const token = authHeader.replace('Bearer ', '');
    const currentUserId = sessions.get(token);
    if (!currentUserId) return res.status(401).json({ error: 'Неверный токен сессии' });

    const query = req.query.q ? req.query.q.trim() : '';
    if (!query) return res.json([]);

    // Очищаем поисковый запрос от символов форматирования телефона и @
    const cleanQuery = query.toLowerCase().replace(/[\s()\-+@]/g, '');

    const foundUsers = [];
    for (const [id, user] of users.entries()) {
        if (id === currentUserId) continue;

        const cleanUserPhone = user.phone.replace(/[\s()\-+]/g, '');
        const userUsername = user.username ? user.username.toLowerCase().replace('@', '') : '';
        const userNameNormalized = user.name.toLowerCase();

        const isPhoneMatch = cleanQuery.length > 0 && cleanUserPhone.includes(cleanQuery);
        const isUsernameMatch = cleanQuery.length > 0 && userUsername.includes(cleanQuery);
        const isNameMatch = userNameNormalized.includes(query.toLowerCase());

        if (isPhoneMatch || isUsernameMatch || isNameMatch) {
            foundUsers.push({
                id: user.id,
                name: user.name,
                phone: user.phone,
                username: user.username,
                bio: user.bio,
                avatarColor: user.avatarColor || 'bg-blue-600',
                status: activeConnections.has(user.id) ? 'online' : 'offline'
            });
        }
    }

    res.json(foundUsers);
});

/**
 * 4. Инициализация/добавление нового чата в личный список
 */
app.post('/api/chats/add', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет авторизации' });

    const token = authHeader.replace('Bearer ', '');
    const currentUserId = sessions.get(token);
    if (!currentUserId) return res.status(401).json({ error: 'Неверный токен сессии' });

    const { partnerId } = req.body;
    if (!partnerId) return res.status(400).json({ error: 'Укажите ID собеседника' });

    const currentUser = users.get(currentUserId);
    const partnerUser = users.get(partnerId);

    if (!currentUser || !partnerUser) {
        return res.status(404).json({ error: 'Один из пользователей не найден' });
    }

    // Добавляем друг друга в список чатов, если их там ещё нет
    if (!currentUser.chats) currentUser.chats = [];
    if (!partnerUser.chats) partnerUser.chats = [];

    let updated = false;
    if (!currentUser.chats.includes(partnerId)) {
        currentUser.chats.push(partnerId);
        updated = true;
    }
    if (!partnerUser.chats.includes(currentUserId)) {
        partnerUser.chats.push(currentUserId);
        updated = true;
    }

    if (updated) {
        users.set(currentUserId, currentUser);
        users.set(partnerId, partnerUser);
        saveUsersToDisk();
    }

    res.json({ success: true });
});

/**
 * 5. Получение списка чатов текущего пользователя (Только те, кого он добавил/нашел)
 */
app.get('/api/chats', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет авторизации' });

    const token = authHeader.replace('Bearer ', '');
    const currentUserId = sessions.get(token);
    if (!currentUserId) return res.status(401).json({ error: 'Неверный токен сессии' });

    const currentUser = users.get(currentUserId);
    if (!currentUser) return res.status(404).json({ error: 'Пользователь не найден' });

    const myChats = currentUser.chats || [];
    const list = [];

    for (const partnerId of myChats) {
        const partner = users.get(partnerId);
        if (partner) {
            list.push({
                id: partner.id,
                name: partner.name,
                phone: partner.phone,
                username: partner.username,
                bio: partner.bio,
                avatarColor: partner.avatarColor || 'bg-blue-600',
                status: activeConnections.has(partner.id) ? 'online' : 'offline'
            });
        }
    }

    res.json(list);
});

/**
 * 6. Обновление профиля пользователя с валидацией уникальности username
 */
app.post('/api/profile/update', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет авторизации' });

    const token = authHeader.replace('Bearer ', '');
    const currentUserId = sessions.get(token);
    if (!currentUserId) return res.status(401).json({ error: 'Неверный токен сессии' });

    const { name, username, bio, avatarColor } = req.body;
    const user = users.get(currentUserId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Проверка уникальности username
    if (username) {
        const cleanUsername = username.trim().toLowerCase().replace('@', '');
        if (cleanUsername.length > 0) {
            if (cleanUsername.length < 3) {
                return res.status(400).json({ error: 'Username должен быть не менее 3 символов' });
            }
            for (const [id, u] of users.entries()) {
                if (id !== currentUserId && u.username && u.username.toLowerCase().replace('@', '') === cleanUsername) {
                    return res.status(400).json({ error: 'Этот @username уже занят другим пользователем' });
                }
            }
            user.username = '@' + cleanUsername;
        } else {
            user.username = '';
        }
    } else {
        user.username = '';
    }

    if (name) user.name = name.trim();
    if (bio !== undefined) user.bio = bio.trim();
    if (avatarColor) user.avatarColor = avatarColor;

    users.set(currentUserId, user);
    saveUsersToDisk();

    // Отправляем обновления на все открытые вкладки/устройства пользователя
    sendToUserDevices(currentUserId, {
        type: 'profile_updated',
        user
    });

    res.json({ success: true, user });
});

/**
 * 7. Загрузка истории переписки (в зашифрованном виде)
 */
app.get('/api/chats/history', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Нет авторизации' });

    const token = authHeader.replace('Bearer ', '');
    const currentUserId = sessions.get(token);
    if (!currentUserId) return res.status(401).json({ error: 'Неверный токен сессии' });

    const withUserId = req.query.userId;
    if (!withUserId) return res.status(400).json({ error: 'Не указан ID собеседника' });

    const chatKey = getChatKey(currentUserId, withUserId);
    const chatFile = path.join(DATA_DIR, `chat_${chatKey}.json`);

    if (fs.existsSync(chatFile)) {
        try {
            const data = fs.readFileSync(chatFile, 'utf8');
            return res.json(JSON.parse(data));
        } catch (e) {
            console.error("Ошибка чтения файла переписки:", e);
        }
    }

    res.json([]);
});

// --- WEBSOCKET ОБРАБОТКА И СИНХРОНИЗАЦИЯ ---

const server = http.createServer(app);
const wsn = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wsn.handleUpgrade(request, socket, head, (ws) => {
        wsn.emit('connection', ws, request);
    });
});

wsn.on('connection', (ws, request) => {
    let authenticatedUserId = null;

    ws.on('message', (messageBytes) => {
        try {
            const data = JSON.parse(messageBytes.toString());
            
            if (data.type === 'auth') {
                const token = data.token;
                const userId = sessions.get(token);
                if (userId) {
                    authenticatedUserId = userId;
                    
                    if (!activeConnections.has(userId)) {
                        activeConnections.set(userId, new Set());
                    }
                    activeConnections.get(userId).add(ws);
                    
                    const user = users.get(userId);
                    if (user) {
                        user.status = 'online';
                        users.set(userId, user);
                    }

                    ws.send(JSON.stringify({ type: 'auth_success', userId, user }));
                    broadcastUserStatus(userId, 'online');
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверный токен сессии' }));
                    ws.close();
                }
                return;
            }

            if (!authenticatedUserId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Требуется авторизация' }));
                return;
            }

            switch (data.type) {
                case 'key_exchange_init': {
                    const { recipientId, initiatorPublicKey } = data;
                    sendToUserDevices(recipientId, {
                        type: 'key_exchange_request',
                        senderId: authenticatedUserId,
                        initiatorPublicKey
                    });
                    break;
                }

                case 'key_exchange_accept': {
                    const { recipientId, recipientPublicKey } = data;
                    sendToUserDevices(recipientId, {
                        type: 'key_exchange_complete',
                        senderId: authenticatedUserId,
                        recipientPublicKey
                    });
                    break;
                }

                case 'secure_message': {
                    const { recipientId, encryptedPayload, iv } = data;
                    const timestamp = Date.now();
                    const messageId = 'msg_' + crypto.randomBytes(12).toString('hex');

                    const messageObj = {
                        id: messageId,
                        senderId: authenticatedUserId,
                        recipientId,
                        encryptedPayload,
                        iv,
                        timestamp
                    };

                    saveMessageToHistory(authenticatedUserId, recipientId, messageObj);

                    // 1. Доставка зашифрованного пакета получателю
                    sendToUserDevices(recipientId, {
                        type: 'secure_message',
                        id: messageId,
                        senderId: authenticatedUserId,
                        encryptedPayload,
                        iv,
                        timestamp
                    });

                    // 2. Доставка на другие устройства этого же отправителя (Синхронизация)
                    sendToUserDevices(authenticatedUserId, {
                        type: 'secure_message_sync',
                        id: messageId,
                        senderId: authenticatedUserId,
                        recipientId,
                        encryptedPayload,
                        iv,
                        timestamp
                    }, ws);
                    
                    break;
                }

                case 'typing': {
                    const { recipientId, isTyping } = data;
                    sendToUserDevices(recipientId, {
                        type: 'typing',
                        senderId: authenticatedUserId,
                        isTyping
                    });
                    break;
                }
            }

        } catch (err) {
            console.error('Ошибка обработки WS сообщения:', err);
        }
    });

    ws.on('close', () => {
        if (authenticatedUserId) {
            const devices = activeConnections.get(authenticatedUserId);
            if (devices) {
                devices.delete(ws);
                if (devices.size === 0) {
                    activeConnections.delete(authenticatedUserId);
                    const user = users.get(authenticatedUserId);
                    if (user) {
                        user.status = 'offline';
                        users.set(authenticatedUserId, user);
                    }
                    broadcastUserStatus(authenticatedUserId, 'offline');
                }
            }
        }
    });
});

function sendToUserDevices(userId, payload, excludeWs = null) {
    const devices = activeConnections.get(userId);
    if (devices) {
        const rawPayload = JSON.stringify(payload);
        devices.forEach(ws => {
            if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
                ws.send(rawPayload);
            }
        });
    }
}

function broadcastUserStatus(userId, status) {
    const payload = JSON.stringify({
        type: 'user_status_change',
        userId,
        status
    });
    for (const [id, devices] of activeConnections.entries()) {
        if (id !== userId) {
            devices.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(payload);
                }
            });
        }
    }
}

function getChatKey(id1, id2) {
    return [id1, id2].sort().join('_');
}

function saveMessageToHistory(user1, user2, messageObj) {
    const chatKey = getChatKey(user1, user2);
    const chatFile = path.join(DATA_DIR, `chat_${chatKey}.json`);
    
    let history = [];
    if (fs.existsSync(chatFile)) {
        try {
            history = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
        } catch (e) {
            console.error("Ошибка разбора истории при сохранении:", e);
        }
    }

    history.push(messageObj);
    
    // Храним последние 500 сообщений в истории
    if (history.length > 500) {
        history.shift();
    }

    try {
        fs.writeFileSync(chatFile, JSON.stringify(history, null, 2), 'utf8');
    } catch (e) {
        console.error("Не удалось записать сообщение в файл истории:", e);
    }

    // Убеждаемся, что чат зафиксирован у обоих пользователей как активный
    const u1 = users.get(user1);
    const u2 = users.get(user2);
    let diskUpdateNeeded = false;

    if (u1 && !u1.chats.includes(user2)) {
        u1.chats.push(user2);
        users.set(user1, u1);
        diskUpdateNeeded = true;
    }
    if (u2 && !u2.chats.includes(user1)) {
        u2.chats.push(user1);
        users.set(user2, u2);
        diskUpdateNeeded = true;
    }

    if (diskUpdateNeeded) {
        saveUsersToDisk();
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`  CipherTalk (КипяТок) Бэкенд запущен!`);
    console.log(`  Все зашифрованные данные сохраняются в папку: server-data/`);
    console.log(`  Порт: ${PORT}`);
    console.log(`  Адрес сервера: https://ciphertalk-server.cloudpub.ru/`);
    console.log(`================================================================`);
});