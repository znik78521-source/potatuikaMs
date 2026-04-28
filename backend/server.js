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
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('avatars'));
app.use(express.static(path.join(__dirname, '../frontend')));

// папки
['uploads', 'avatars', 'data'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d);
});

const DATA_DIR = './data';
const load = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return {}; }
};
const save = (f, d) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2));

let users = load('users.json');
let messages = load('messages.json');
let sessions = load('sessions.json');

const saveAll = () => {
  save('users.json', users);
  save('messages.json', messages);
  save('sessions.json', sessions);
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'avatar' ? 'avatars' : 'uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

function cleanUsername(u) {
  if (!u) return '';
  while (u.startsWith('@')) u = u.slice(1);
  return u;
}

function formatLastSeen(ts) {
  if (!ts) return 'давно';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} д назад`;
}

// ------------------ API ------------------
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  const clean = cleanUsername(username);
  if (users[clean]) return res.status(400).json({ error: 'Уже есть' });
  const hash = await bcrypt.hash(password, 10);
  users[clean] = {
    username: clean,
    passwordHash: hash,
    displayName: displayName || clean,
    avatar: null,
    online: false,
    lastSeen: null
  };
  const token = jwt.sign({ username: clean }, 'SECRET');
  sessions[token] = clean;
  saveAll();
  res.json({ token, user: users[clean] });
});

app.post('/api/login', async (req, res) => {
  const { username, password, token: saved } = req.body;
  if (saved && sessions[saved]) {
    const name = sessions[saved];
    if (users[name]) return res.json({ token: saved, user: users[name] });
  }
  const clean = cleanUsername(username);
  const user = users[clean];
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    return res.status(401).json({ error: 'Неверно' });
  const token = jwt.sign({ username: clean }, 'SECRET');
  sessions[token] = clean;
  saveAll();
  res.json({ token, user });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const url = `/${req.file.fieldname === 'avatar' ? 'avatars' : 'uploads'}/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 'file';
  res.json({ url, type, name: req.file.originalname });
});

app.post('/api/update-profile', (req, res) => {
  const { token, displayName, bio, avatar, theme } = req.body;
  const name = sessions[token];
  if (users[name]) {
    if (displayName) users[name].displayName = displayName;
    if (bio !== undefined) users[name].bio = bio;
    if (avatar) users[name].avatar = avatar;
    if (theme) users[name].theme = theme;
    saveAll();
    res.json({ success: true, user: users[name] });
  } else res.status(401).json({ error: 'Не авторизован' });
});

app.get('/api/search', (req, res) => {
  const q = req.query.q?.toLowerCase() || '';
  const clean = cleanUsername(q);
  const list = Object.values(users).filter(u =>
    u.username.includes(clean) || u.displayName?.toLowerCase().includes(clean)
  ).map(u => ({ username: u.username, displayName: u.displayName, avatar: u.avatar, online: u.online, lastSeen: u.lastSeen }));
  res.json(list);
});

app.get('/api/user-status/:username', (req, res) => {
  const user = users[req.params.username];
  if (user) res.json({ online: user.online || false, lastSeen: user.lastSeen, lastSeenFormatted: formatLastSeen(user.lastSeen) });
  else res.status(404).json({ error: 'Нет' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ------------------ WEBSOCKET ------------------
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  const name = sessions[token];
  if (!name) return next(new Error('Неверный токен'));
  socket.username = name;
  next();
});

io.on('connection', (socket) => {
  const username = socket.username;
  console.log(`✅ ${username} connected`);

  // статус онлайн
  if (users[username]) {
    users[username].online = true;
    users[username].lastSeen = Date.now();
    saveAll();
    io.emit('user_status_change', { username, online: true, lastSeen: users[username].lastSeen, lastSeenFormatted: formatLastSeen(users[username].lastSeen) });
  }

  // подписываем на личную комнату (ОЧЕНЬ ВАЖНО!)
  socket.join(username);

  // собираем чаты
  const dmChats = [];
  Object.keys(messages).forEach(chatId => {
    if (chatId.includes(username)) {
      const other = chatId.replace(username, '').replace(/_/g, '');
      if (other && users[other]) {
        dmChats.push({ id: chatId, type: 'dm', with: other, lastMessage: messages[chatId][messages[chatId].length - 1] });
      }
    }
  });

  socket.emit('init', {
    user: users[username],
    chats: dmChats
  });

  // ========= ОТПРАВКА СООБЩЕНИЯ =========
  socket.on('send_message', (data) => {
    const { to, type, text, attachments } = data;
    console.log(`✉️ ${username} -> ${to} : ${text}`);

    const message = {
      id: uuidv4(),
      from: username,
      to: to,
      text: text,
      attachments: attachments || [],
      timestamp: Date.now(),
      type: type
    };

    let chatId;
    if (type === 'dm') {
      chatId = [username, to].sort().join('_');
      if (!messages[chatId]) messages[chatId] = [];
      messages[chatId].push(message);
      saveAll();

      // себе
      socket.emit('new_message', message);
      // получателю (ОБЯЗАТЕЛЬНО через комнату)
      io.to(to).emit('new_message', message);
      console.log(`✅ отправлено ${to}`);
    }
  });

  socket.on('load_chat', ({ chatId }) => {
    socket.emit('chat_history', { chatId, messages: messages[chatId] || [] });
  });

  socket.on('get_user_status', ({ username: target }) => {
    const u = users[target];
    if (u) socket.emit('user_status', { username: target, online: u.online, lastSeen: u.lastSeen, lastSeenFormatted: formatLastSeen(u.lastSeen) });
  });

  socket.on('typing', ({ chatId, isTyping }) => {
    socket.to(chatId).emit('user_typing', { username, chatId, isTyping });
  });

  socket.on('disconnect', () => {
    if (users[username]) {
      users[username].online = false;
      users[username].lastSeen = Date.now();
      saveAll();
      io.emit('user_status_change', { username, online: false, lastSeen: users[username].lastSeen, lastSeenFormatted: formatLastSeen(users[username].lastSeen) });
    }
    console.log(`❌ ${username} disconnected`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`💜💚 Potatuika работает на http://localhost:${PORT}`);
});