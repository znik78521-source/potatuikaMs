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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use(express.static(path.join(__dirname, '../frontend')));

// Создаём папки
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// ===== ВРЕМЕННАЯ БАЗА ДАННЫХ (в памяти) =====
const users = new Map();
const messages = new Map();
const channels = new Map();

// Добавляем тестовых пользователей
const testHash = bcrypt.hashSync('123', 10);
users.set('alex', {
  username: 'alex',
  passwordHash: testHash,
  displayName: 'Алексей',
  avatar: null,
  online: false,
  socketId: null
});
users.set('maria', {
  username: 'maria',
  passwordHash: testHash,
  displayName: 'Мария',
  avatar: null,
  online: false,
  socketId: null
});

// Тестовый канал
channels.set('general', {
  id: 'general',
  name: '💬 Общий чат',
  description: 'Для всех',
  creator: 'alex',
  subscribers: ['alex', 'maria'],
  admins: ['alex'],
  messages: []
});

// ===== API =====
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  
  if (users.has(username)) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }
  
  const passwordHash = await bcrypt.hash(password, 10);
  users.set(username, {
    username,
    passwordHash,
    displayName: displayName || username,
    avatar: null,
    online: false,
    socketId: null
  });
  
  const token = jwt.sign({ username }, 'SECRET_KEY');
  res.json({ token, user: { username, displayName: displayName || username } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  
  const token = jwt.sign({ username }, 'SECRET_KEY');
  res.json({ token, user: { username, displayName: user.displayName, avatar: user.avatar } });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const fileUrl = `http://localhost:3000/uploads/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 
                req.file.mimetype.startsWith('video/') ? 'video' : 'file';
  res.json({ url: fileUrl, type, name: req.file.originalname });
});

app.get('/api/search', (req, res) => {
  const query = req.query.q?.toLowerCase() || '';
  const results = Array.from(users.values())
    .filter(u => u.username.includes(query) || u.displayName.includes(query))
    .map(u => ({ username: u.username, displayName: u.displayName, avatar: u.avatar, online: u.online }));
  res.json(results);
});

app.get('/api/channels', (req, res) => {
  const list = Array.from(channels.values()).map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    subscribers: c.subscribers.length
  }));
  res.json(list);
});

// ДЛЯ ВСЕХ ОСТАЛЬНЫХ ЗАПРОСОВ - ОТДАЁМ HTML
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ===== WEBSOCKET =====
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  
  try {
    const decoded = jwt.verify(token, 'SECRET_KEY');
    socket.username = decoded.username;
    next();
  } catch (err) {
    next(new Error('Неверный токен'));
  }
});

io.on('connection', (socket) => {
  const username = socket.username;
  const user = users.get(username);
  
  if (user) {
    user.online = true;
    user.socketId = socket.id;
    
    // Загружаем чаты пользователя
    const userChats = [];
    for (let [chatId, msgs] of messages.entries()) {
      if (chatId.includes(username)) {
        const other = chatId.replace(username, '').replace('_', '');
        const otherUser = users.get(other);
        userChats.push({
          id: chatId,
          type: 'dm',
          with: other,
          displayName: otherUser?.displayName || other,
          lastMessage: msgs[msgs.length - 1]
        });
      }
    }
    
    const userChannels = Array.from(channels.values())
      .filter(c => c.subscribers.includes(username))
      .map(c => ({ id: c.id, type: 'channel', name: c.name }));
    
    socket.emit('init', {
      chats: [...userChats, ...userChannels],
      user: { username, displayName: user.displayName, avatar: user.avatar }
    });
    
    socket.broadcast.emit('user_online', { username });
  }
  
  // Отправка сообщения
  socket.on('send_message', (data) => {
    const { to, type, text, attachments } = data;
    
    const message = {
      id: uuidv4(),
      from: username,
      to,
      text,
      attachments: attachments || [],
      timestamp: Date.now(),
      type
    };
    
    if (type === 'dm') {
      const chatId = [username, to].sort().join('_');
      if (!messages.has(chatId)) messages.set(chatId, []);
      messages.get(chatId).push(message);
      
      const recipient = users.get(to);
      if (recipient && recipient.socketId) {
        io.to(recipient.socketId).emit('new_message', message);
      }
      socket.emit('new_message', message);
    }
    else if (type === 'channel') {
      const channel = channels.get(to);
      if (channel && channel.subscribers.includes(username)) {
        channel.messages.push(message);
        channel.subscribers.forEach(sub => {
          const subUser = users.get(sub);
          if (subUser && subUser.socketId) {
            io.to(subUser.socketId).emit('new_message', message);
          }
        });
      }
    }
  });
  
  // Загрузка истории
  socket.on('load_chat', ({ with: target, type }) => {
    if (type === 'dm') {
      const chatId = [username, target].sort().join('_');
      const history = messages.get(chatId) || [];
      const otherUser = users.get(target);
      socket.emit('chat_history', {
        messages: history,
        target,
        type,
        userInfo: {
          username: target,
          displayName: otherUser?.displayName || target,
          online: otherUser?.online
        }
      });
    }
    else if (type === 'channel') {
      const channel = channels.get(target);
      if (channel) {
        socket.emit('chat_history', {
          messages: channel.messages,
          target,
          type,
          channelInfo: { name: channel.name, description: channel.description }
        });
      }
    }
  });
  
  // Создание канала
  socket.on('create_channel', ({ name, description }) => {
    const channelId = name.toLowerCase().replace(/\s/g, '_') + Date.now();
    channels.set(channelId, {
      id: channelId,
      name,
      description: description || '',
      creator: username,
      subscribers: [username],
      admins: [username],
      messages: []
    });
    socket.emit('channel_created', { id: channelId, name });
    io.emit('channel_list_update', Array.from(channels.values()).map(c => ({
      id: c.id, name: c.name, subscribers: c.subscribers.length
    })));
  });
  
  // Подписка на канал
  socket.on('join_channel', (channelId) => {
    const channel = channels.get(channelId);
    if (channel && !channel.subscribers.includes(username)) {
      channel.subscribers.push(username);
      socket.emit('channel_joined', { id: channelId, name: channel.name });
    }
  });
  
  socket.on('disconnect', () => {
    if (user) {
      user.online = false;
      user.socketId = null;
      socket.broadcast.emit('user_offline', { username });
    }
  });
});

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log('💜💚 POTATUIKA MESSENGER ЗАПУЩЕН!');
  console.log(`📍 http://localhost:${PORT}`);
  console.log('📝 Тестовые аккаунты: alex/123  или  maria/123');
});