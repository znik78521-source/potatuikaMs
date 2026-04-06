import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('avatars'));
app.use(express.static(path.join(__dirname, '../frontend')));

// Создаем папки
['uploads', 'avatars', 'data'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// ===== ПОСТОЯННОЕ ХРАНЕНИЕ =====
const DATA_DIR = './data';
const loadData = (filename) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
  } catch {
    return {};
  }
};
const saveData = (filename, data) => {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
};

let users = loadData('users.json');
let messages = loadData('messages.json');
let groups = loadData('groups.json');
let channels = loadData('channels.json');
let sessions = loadData('sessions.json');

const saveAll = () => {
  saveData('users.json', users);
  saveData('messages.json', messages);
  saveData('groups.json', groups);
  saveData('channels.json', channels);
  saveData('sessions.json', sessions);
};

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === 'avatar' ? 'avatars' : 'uploads';
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function cleanUsername(username) {
  if (!username) return '';
  while (username.startsWith('@')) username = username.substring(1);
  return username;
}

function formatLastSeen(timestamp) {
  if (!timestamp) return 'давно';
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (hours < 24) return `${hours} ч назад`;
  return `${days} д назад`;
}

// ===== DEEPSEEK API =====
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('❌ НЕТ DEEPSEEK API КЛЮЧА! Создай файл .env в папке backend');
}

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

async function getBotReply(userMessage, username) {
  if (!DEEPSEEK_API_KEY) {
    return '🤖 Извини, API ключ не настроен. Попроси администратора добавить DEEPSEEK_API_KEY в .env файл!';
  }
  
  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `Ты бот "Andrysha nextbot" в мессенджере Potatuika. 
                      Твой создатель - Andrysha. 
                      Ты общаешься с пользователем ${username}.
                      Отвечай кратко (1-2 предложения), дружелюбно, используй эмодзи.
                      Будь веселым и полезным. Если тебя спрашивают о возможностях - расскажи, что ты на DeepSeek API.`
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        temperature: 0.9,
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('DeepSeek ошибка:', error.response?.data || error.message);
    const fallbacks = [
      '🤖 Ой, у меня проблемы с интернетом... Напиши позже!',
      '😅 Что-то я завис... Попробуй еще раз!',
      '🔌 Кажется, DeepSeek отключился... Напиши позже!'
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// ===== БОТ ANDRYSHA NEXTBOT =====
const BOT_USERNAME = 'andrysha_nextbot';
const BOT_DISPLAY_NAME = 'Andrysha nextbot 🤖';
const BOT_AVATAR_URL = '/avatars/andrysha_bot.png';

async function initBot() {
  const botExists = users[BOT_USERNAME];
  
  if (!botExists) {
    const botPasswordHash = await bcrypt.hash('bot123456', 10);
    users[BOT_USERNAME] = {
      username: BOT_USERNAME,
      passwordHash: botPasswordHash,
      displayName: BOT_DISPLAY_NAME,
      bio: '🤖 Я умный бот на DeepSeek API! Могу отвечать на любые вопросы, шутить и помогать! Спрашивай что угодно!',
      avatar: BOT_AVATAR_URL,
      theme: 'purple-green',
      isBot: true,
      createdAt: Date.now(),
      online: true,
      lastSeen: Date.now()
    };
    console.log('🤖 Бот Andrysha nextbot (DeepSeek) создан!');
    saveAll();
  } else {
    if (!users[BOT_USERNAME].avatar) {
      users[BOT_USERNAME].avatar = BOT_AVATAR_URL;
      saveAll();
    }
    users[BOT_USERNAME].online = true;
    users[BOT_USERNAME].lastSeen = Date.now();
  }
}

// ===== API =====
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  const cleanUser = cleanUsername(username);
  
  if (users[cleanUser]) {
    return res.status(400).json({ error: 'Username уже существует' });
  }
  
  const passwordHash = await bcrypt.hash(password, 10);
  users[cleanUser] = {
    username: cleanUser,
    passwordHash,
    displayName: displayName || cleanUser,
    bio: '',
    avatar: null,
    theme: 'purple-green',
    isBot: false,
    createdAt: Date.now(),
    online: true,
    lastSeen: Date.now()
  };
  
  const token = jwt.sign({ username: cleanUser }, 'SECRET_KEY');
  sessions[token] = cleanUser;
  saveAll();
  
  // Сразу возвращаем токен и пользователя (авто-вход после регистрации)
  res.json({ token, user: users[cleanUser] });
});

app.post('/api/login', async (req, res) => {
  const { username, password, token: savedToken } = req.body;
  
  // Авто-вход по токену
  if (savedToken && sessions[savedToken]) {
    const usernameFromToken = sessions[savedToken];
    if (users[usernameFromToken]) {
      users[usernameFromToken].online = true;
      users[usernameFromToken].lastSeen = Date.now();
      saveAll();
      return res.json({ token: savedToken, user: users[usernameFromToken] });
    }
  }
  
  // Обычный вход
  const cleanUser = cleanUsername(username);
  const user = users[cleanUser];
  
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  
  const token = jwt.sign({ username: cleanUser }, 'SECRET_KEY');
  sessions[token] = cleanUser;
  user.online = true;
  user.lastSeen = Date.now();
  saveAll();
  
  res.json({ token, user });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const fileUrl = `/${req.file.fieldname === 'avatar' ? 'avatars' : 'uploads'}/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 
                req.file.mimetype.startsWith('video/') ? 'video' : 
                req.file.mimetype === 'audio/mpeg' ? 'audio' : 'file';
  res.json({ url: fileUrl, type, name: req.file.originalname });
});

app.post('/api/update-profile', async (req, res) => {
  const { token, displayName, bio, avatar, theme } = req.body;
  const username = sessions[token];
  
  if (users[username]) {
    if (displayName) users[username].displayName = displayName;
    if (bio !== undefined) users[username].bio = bio;
    if (avatar) users[username].avatar = avatar;
    if (theme) users[username].theme = theme;
    saveAll();
    res.json({ success: true, user: users[username] });
  } else {
    res.status(401).json({ error: 'Не авторизован' });
  }
});

app.post('/api/create-group', (req, res) => {
  const { token, name, description } = req.body;
  const creator = sessions[token];
  
  const groupId = uuidv4();
  groups[groupId] = {
    id: groupId,
    type: 'group',
    name,
    description: description || '',
    avatar: null,
    creator,
    members: [creator],
    admins: [creator],
    createdAt: Date.now()
  };
  saveAll();
  res.json({ success: true, group: groups[groupId] });
});

app.post('/api/create-channel', (req, res) => {
  const { token, name, description } = req.body;
  const creator = sessions[token];
  
  const channelId = uuidv4();
  channels[channelId] = {
    id: channelId,
    type: 'channel',
    name,
    description: description || '',
    avatar: null,
    creator,
    subscribers: [creator],
    createdAt: Date.now()
  };
  saveAll();
  res.json({ success: true, channel: channels[channelId] });
});

app.get('/api/search', (req, res) => {
  const query = req.query.q?.toLowerCase() || '';
  const cleanQuery = cleanUsername(query);
  
  const results = Object.values(users)
    .filter(u => !u.isBot && (u.username.toLowerCase().includes(cleanQuery) || 
                  u.displayName.toLowerCase().includes(cleanQuery)))
    .map(u => ({ 
      username: u.username, 
      displayName: u.displayName, 
      avatar: u.avatar,
      online: u.online,
      lastSeen: u.lastSeen
    }));
  res.json(results);
});

app.get('/api/user-status/:username', (req, res) => {
  const user = users[req.params.username];
  if (user) {
    res.json({
      online: user.online || false,
      lastSeen: user.lastSeen,
      lastSeenFormatted: formatLastSeen(user.lastSeen)
    });
  } else {
    res.status(404).json({ error: 'Пользователь не найден' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ===== WEBSOCKET =====
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  
  const username = sessions[token];
  if (!username) return next(new Error('Неверный токен'));
  
  socket.username = username;
  next();
});

io.on('connection', async (socket) => {
  const username = socket.username;
  console.log(`✅ ${username} подключился`);
  
  // Обновляем статус пользователя
  if (users[username] && !users[username].isBot) {
    users[username].online = true;
    users[username].lastSeen = Date.now();
    saveAll();
    
    io.emit('user_status_change', { 
      username, 
      online: true, 
      lastSeen: users[username].lastSeen,
      lastSeenFormatted: formatLastSeen(users[username].lastSeen)
    });
  }
  
  // Инициализируем бота
  await initBot();
  
  // Отправляем все чаты пользователя
  const userGroups = Object.values(groups).filter(g => g.members.includes(username));
  const userChannels = Object.values(channels).filter(c => c.subscribers.includes(username));
  const userDMs = [];
  
  Object.keys(messages).forEach(chatId => {
    if (chatId.includes(username)) {
      const other = chatId.replace(username, '').replace(/_/g, '');
      if (other && users[other]) {
        userDMs.push({ 
          id: chatId, 
          type: 'dm', 
          with: other,
          lastMessage: messages[chatId][messages[chatId].length - 1]
        });
      }
    }
  });
  
  // Добавляем чат с ботом если его нет
  const botChatId = [username, BOT_USERNAME].sort().join('_');
  if (!userDMs.find(dm => dm.with === BOT_USERNAME)) {
    userDMs.push({ id: botChatId, type: 'dm', with: BOT_USERNAME });
  }
  
  socket.emit('init', {
    user: users[username],
    chats: [...userDMs, ...userGroups, ...userChannels]
  });
  
  // Отправляем статусы всех пользователей
  const allStatuses = {};
  Object.keys(users).forEach(u => {
    if (!users[u].isBot) {
      allStatuses[u] = {
        online: users[u].online || false,
        lastSeen: users[u].lastSeen,
        lastSeenFormatted: formatLastSeen(users[u].lastSeen)
      };
    }
  });
  socket.emit('all_user_statuses', allStatuses);
  
  // Отправка сообщения
  socket.on('send_message', async (data) => {
    const { to, type, text, attachments } = data;
    
    // Обработка сообщений боту с DeepSeek
    if (type === 'dm' && to === BOT_USERNAME) {
      const botReply = await getBotReply(text, username);
      
      const chatId = [username, BOT_USERNAME].sort().join('_');
      
      const userMessage = {
        id: uuidv4(),
        from: username,
        to: BOT_USERNAME,
        text: text,
        attachments: [],
        timestamp: Date.now(),
        type: 'dm',
        read: false
      };
      
      const botMessage = {
        id: uuidv4(),
        from: BOT_USERNAME,
        to: username,
        text: botReply,
        attachments: [],
        timestamp: Date.now(),
        type: 'dm',
        read: false
      };
      
      if (!messages[chatId]) messages[chatId] = [];
      messages[chatId].push(userMessage);
      messages[chatId].push(botMessage);
      saveAll();
      
      socket.emit('new_message', userMessage);
      socket.emit('new_message', botMessage);
      
      const recipientSocket = [...io.sockets.sockets.values()].find(s => s.username === username);
      if (recipientSocket) {
        recipientSocket.emit('new_message', botMessage);
      }
      return;
    }
    
    // Обычная отправка
    const message = {
      id: uuidv4(),
      from: username,
      to: to,
      text: text,
      attachments: attachments || [],
      timestamp: Date.now(),
      type: type,
      read: false
    };
    
    let chatId;
    
    if (type === 'dm') {
      chatId = [username, to].sort().join('_');
      if (!messages[chatId]) messages[chatId] = [];
      messages[chatId].push(message);
      saveAll();
      
      socket.emit('new_message', message);
      
      const recipientSocket = [...io.sockets.sockets.values()].find(s => s.username === to);
      if (recipientSocket) {
        recipientSocket.emit('new_message', message);
      }
    }
    else if (type === 'group') {
      const group = groups[to];
      if (group && group.members.includes(username)) {
        if (!messages[to]) messages[to] = [];
        messages[to].push(message);
        saveAll();
        
        socket.emit('new_message', message);
        
        group.members.forEach(member => {
          if (member !== username) {
            const memberSocket = [...io.sockets.sockets.values()].find(s => s.username === member);
            if (memberSocket) memberSocket.emit('new_message', message);
          }
        });
      }
    }
    else if (type === 'channel') {
      const channel = channels[to];
      if (channel && channel.subscribers.includes(username)) {
        if (!messages[to]) messages[to] = [];
        messages[to].push(message);
        saveAll();
        
        socket.emit('new_message', message);
        
        channel.subscribers.forEach(sub => {
          if (sub !== username) {
            const subSocket = [...io.sockets.sockets.values()].find(s => s.username === sub);
            if (subSocket) subSocket.emit('new_message', message);
          }
        });
      }
    }
  });
  
  // Загрузка истории
  socket.on('load_chat', ({ chatId }) => {
    const history = messages[chatId] || [];
    socket.emit('chat_history', { chatId, messages: history });
  });
  
  // Получение статуса пользователя
  socket.on('get_user_status', ({ username: targetUsername }) => {
    const user = users[targetUsername];
    if (user) {
      socket.emit('user_status', {
        username: targetUsername,
        online: user.online || false,
        lastSeen: user.lastSeen,
        lastSeenFormatted: formatLastSeen(user.lastSeen)
      });
    }
  });
  
  socket.on('disconnect', () => {
    if (users[username] && !users[username].isBot) {
      users[username].online = false;
      users[username].lastSeen = Date.now();
      saveAll();
      
      io.emit('user_status_change', { 
        username, 
        online: false, 
        lastSeen: users[username].lastSeen,
        lastSeenFormatted: formatLastSeen(users[username].lastSeen)
      });
    }
    console.log(`❌ ${username} отключился`);
  });
});

// Авто-сохранение каждые 5 секунд
setInterval(() => saveAll(), 5000);

// Запуск бота
initBot();

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('💜💚 POTATUIKA ЗАПУЩЕН!');
  console.log(`📍 http://localhost:${PORT}`);
  console.log('🤖 Бот Andrysha nextbot на DeepSeek API готов к общению!');
});