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

// ===== ПОСТОЯННОЕ ХРАНЕНИЕ В ФАЙЛАХ =====
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

// Инициализация данных
let users = loadData('users.json');
let messages = loadData('messages.json');
let groups = loadData('groups.json');
let channels = loadData('channels.json');
let sessions = loadData('sessions.json');

// Сохранение при изменении
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

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
function cleanUsername(username) {
  if (!username) return '';
  let clean = username;
  while (clean.startsWith('@')) {
    clean = clean.substring(1);
  }
  return clean;
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
  const { token, name, description, members } = req.body;
  const creator = sessions[token];
  
  const groupId = uuidv4();
  groups[groupId] = {
    id: groupId,
    type: 'group',
    name,
    description: description || '',
    avatar: null,
    creator,
    members: [creator, ...(members || [])],
    admins: [creator],
    createdAt: Date.now()
  };
  saveAll();
  res.json({ success: true, group: groups[groupId] });
});

app.post('/api/create-channel', (req, res) => {
  const { token, name, description, isPrivate } = req.body;
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
    isPrivate: isPrivate || false,
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
    .map(u => ({ 
      username: u.username,
      displayName: u.displayName, 
      avatar: u.avatar 
    }));
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
  
  // Отправляем все чаты пользователя
  const userGroups = Object.values(groups).filter(g => g.members.includes(username));
  const userChannels = Object.values(channels).filter(c => c.subscribers.includes(username));
  const userDMs = [];
  
  // Собираем личные диалоги
  Object.keys(messages).forEach(chatId => {
    if (chatId.includes(username)) {
      const other = chatId.replace(username, '').replace('_', '');
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
    chats: [...userDMs, ...userGroups, ...userChannels]
  });
  
  // Отправка сообщения
  socket.on('send_message', (data) => {
    const { to, type, text, attachments } = data;
    const cleanTo = cleanUsername(to);
    
    const message = {
      id: uuidv4(),
      from: username,
      to: cleanTo,
      text: text,
      attachments: attachments || [],
      timestamp: Date.now(),
      type: type
    };
    
    let chatId;
    if (type === 'dm') {
      chatId = [username, cleanTo].sort().join('_');
      if (!messages[chatId]) messages[chatId] = [];
      messages[chatId].push(message);
      saveAll();
      
      // Отправляем отправителю
      socket.emit('new_message', message);
      
      // Отправляем получателю
      const recipientSocket = [...io.sockets.sockets.values()].find(s => s.username === cleanTo);
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
  
  socket.on('disconnect', () => {
    console.log(`❌ ${username} отключился`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('💜💚 POTATUIKA 2.0 ЗАПУЩЕН!');
  console.log(`📍 http://localhost:${PORT}`);
});