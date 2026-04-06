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
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('avatars'));
app.use('/stickers', express.static('stickers'));
app.use(express.static(path.join(__dirname, '../frontend')));

// Создаем папки
['uploads', 'avatars', 'stickers', 'data'].forEach(dir => {
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
let stickers = loadData('stickers.json'); // Авторские смайлики
let deletedMessages = loadData('deleted.json'); // Удаленные сообщения

const saveAll = () => {
  saveData('users.json', users);
  saveData('messages.json', messages);
  saveData('groups.json', groups);
  saveData('channels.json', channels);
  saveData('sessions.json', sessions);
  saveData('stickers.json', stickers);
  saveData('deleted.json', deletedMessages);
};

// Настройка загрузки
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads';
    if (file.fieldname === 'avatar') folder = 'avatars';
    if (file.fieldname === 'sticker') folder = 'stickers';
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function cleanUsername(username) {
  if (!username) return '';
  while (username.startsWith('@')) username = username.substring(1);
  return username;
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
    createdAt: Date.now()
  };
  
  const token = jwt.sign({ username: cleanUser }, 'SECRET_KEY');
  sessions[token] = cleanUser;
  saveAll();
  
  res.json({ token, user: users[cleanUser] });
});

app.post('/api/login', async (req, res) => {
  const { username, password, token: savedToken } = req.body;
  
  if (savedToken && sessions[savedToken]) {
    const usernameFromToken = sessions[savedToken];
    if (users[usernameFromToken]) {
      return res.json({ token: savedToken, user: users[usernameFromToken] });
    }
  }
  
  const cleanUser = cleanUsername(username);
  const user = users[cleanUser];
  
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  
  const token = jwt.sign({ username: cleanUser }, 'SECRET_KEY');
  sessions[token] = cleanUser;
  saveAll();
  
  res.json({ token, user });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const fileUrl = `/${req.file.fieldname === 'avatar' ? 'avatars' : req.file.fieldname === 'sticker' ? 'stickers' : 'uploads'}/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 
                req.file.mimetype.startsWith('video/') ? 'video' : 
                req.file.mimetype === 'audio/mpeg' ? 'audio' : 'file';
  res.json({ url: fileUrl, type, name: req.file.originalname });
});

app.post('/api/create-sticker', upload.single('sticker'), (req, res) => {
  const { token, name } = req.body;
  const username = sessions[token];
  
  if (!username) return res.status(401).json({ error: 'Не авторизован' });
  
  const stickerId = uuidv4();
  const stickerUrl = `/stickers/${req.file.filename}`;
  
  if (!stickers[username]) stickers[username] = [];
  stickers[username].push({
    id: stickerId,
    name: name || 'sticker',
    url: stickerUrl,
    createdAt: Date.now()
  });
  saveAll();
  
  res.json({ success: true, sticker: { id: stickerId, name: name || 'sticker', url: stickerUrl } });
});

app.get('/api/get-stickers', (req, res) => {
  const { token } = req.query;
  const username = sessions[token];
  
  if (!username) return res.json([]);
  
  const userStickers = stickers[username] || [];
  const globalStickers = stickers['global'] || [];
  
  res.json([...userStickers, ...globalStickers]);
});

app.delete('/api/delete-sticker', (req, res) => {
  const { token, stickerId } = req.body;
  const username = sessions[token];
  
  if (stickers[username]) {
    stickers[username] = stickers[username].filter(s => s.id !== stickerId);
    saveAll();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Стикер не найден' });
  }
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

app.post('/api/delete-message', (req, res) => {
  const { token, messageId, chatId, forEveryone } = req.body;
  const username = sessions[token];
  
  if (messages[chatId]) {
    const messageIndex = messages[chatId].findIndex(m => m.id === messageId);
    if (messageIndex !== -1) {
      const message = messages[chatId][messageIndex];
      
      if (message.from === username || forEveryone) {
        if (forEveryone) {
          messages[chatId].splice(messageIndex, 1);
        } else {
          message.deletedFor = message.deletedFor || [];
          message.deletedFor.push(username);
          message.text = '[Сообщение удалено]';
          message.attachments = [];
        }
        saveAll();
        res.json({ success: true });
        
        // Уведомляем всех в чате
        io.emit('message_deleted', { chatId, messageId, forEveryone });
      }
    }
  }
});

app.post('/api/edit-message', (req, res) => {
  const { token, messageId, chatId, newText } = req.body;
  const username = sessions[token];
  
  if (messages[chatId]) {
    const message = messages[chatId].find(m => m.id === messageId);
    if (message && message.from === username) {
      message.text = newText;
      message.edited = true;
      message.editedAt = Date.now();
      saveAll();
      res.json({ success: true });
      io.emit('message_edited', { chatId, messageId, newText });
    }
  }
});

app.post('/api/pin-message', (req, res) => {
  const { token, messageId, chatId } = req.body;
  const username = sessions[token];
  
  if (messages[chatId]) {
    const message = messages[chatId].find(m => m.id === messageId);
    if (message) {
      message.pinned = !message.pinned;
      saveAll();
      res.json({ success: true, pinned: message.pinned });
      io.emit('message_pinned', { chatId, messageId, pinned: message.pinned });
    }
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
    moderators: [],
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
    .filter(u => u.username.toLowerCase().includes(cleanQuery) || 
                  u.displayName.toLowerCase().includes(cleanQuery))
    .map(u => ({ username: u.username, displayName: u.displayName, avatar: u.avatar }));
  res.json(results);
});

app.get('/api/search-messages', (req, res) => {
  const { chatId, q } = req.query;
  const chatMessages = messages[chatId] || [];
  const results = chatMessages.filter(m => 
    m.text && m.text.toLowerCase().includes(q.toLowerCase())
  );
  res.json(results);
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

io.on('connection', (socket) => {
  const username = socket.username;
  console.log(`✅ ${username} подключился`);
  
  // Обновляем онлайн статус
  if (users[username]) {
    users[username].online = true;
    users[username].lastSeen = Date.now();
    io.emit('user_status', { username, online: true, lastSeen: Date.now() });
  }
  
  // Отправляем чаты
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
  
  socket.emit('init', {
    user: users[username],
    chats: [...userDMs, ...userGroups, ...userChannels],
    stickers: stickers[username] || []
  });
  
  // Отправка сообщения
  socket.on('send_message', (data) => {
    const { to, type, text, attachments, replyTo } = data;
    
    const message = {
      id: uuidv4(),
      from: username,
      to: to,
      text: text,
      attachments: attachments || [],
      replyTo: replyTo || null,
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
      if (recipientSocket) recipientSocket.emit('new_message', message);
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
  
  // Печатает...
  socket.on('typing', ({ chatId, isTyping }) => {
    socket.broadcast.emit('user_typing', { username, chatId, isTyping });
  });
  
  // Прочитано
  socket.on('mark_read', ({ chatId }) => {
    if (messages[chatId]) {
      messages[chatId].forEach(msg => {
        if (msg.to === username && !msg.read) {
          msg.read = true;
        }
      });
      saveAll();
      socket.emit('messages_read', { chatId });
    }
  });
  
  // Загрузка истории
  socket.on('load_chat', ({ chatId }) => {
    const history = messages[chatId] || [];
    socket.emit('chat_history', { chatId, messages: history });
  });
  
  socket.on('disconnect', () => {
    if (users[username]) {
      users[username].online = false;
      users[username].lastSeen = Date.now();
      io.emit('user_status', { username, online: false, lastSeen: Date.now() });
    }
    console.log(`❌ ${username} отключился`);
  });
});

// Авто-сохранение
setInterval(() => saveAll(), 30000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('💜💚 POTATUIKA 3.0 ЗАПУЩЕН!');
  console.log(`📍 http://localhost:${PORT}`);
});