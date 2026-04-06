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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('avatars'));
app.use('/stickers', express.static('stickers'));
app.use('/voice', express.static('voice'));
app.use(express.static(path.join(__dirname, '../frontend')));

// Создаем папки
['uploads', 'avatars', 'stickers', 'data', 'voice'].forEach(dir => {
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
let stickers = loadData('stickers.json');
let polls = loadData('polls.json');

const saveAll = () => {
  saveData('users.json', users);
  saveData('messages.json', messages);
  saveData('groups.json', groups);
  saveData('channels.json', channels);
  saveData('sessions.json', sessions);
  saveData('stickers.json', stickers);
  saveData('polls.json', polls);
  console.log('💾 Все данные сохранены');
};

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads';
    if (file.fieldname === 'avatar') folder = 'avatars';
    if (file.fieldname === 'sticker') folder = 'stickers';
    if (file.fieldname === 'voice') folder = 'voice';
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function cleanUsername(username) {
  if (!username) return '';
  while (username.startsWith('@')) username = username.substring(1);
  return username;
}

function formatLastSeen(timestamp) {
  if (!timestamp) return 'давно';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (hours < 24) return `${hours} ч назад`;
  return `${days} д назад`;
}

// ===== API =====
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  const cleanUser = cleanUsername(username);
  if (users[cleanUser]) return res.status(400).json({ error: 'Username уже существует' });
  const passwordHash = await bcrypt.hash(password, 10);
  users[cleanUser] = {
    username: cleanUser, passwordHash, displayName: displayName || cleanUser, bio: '', avatar: null,
    theme: 'purple-green', isBot: false, createdAt: Date.now(), online: false, lastSeen: null,
    roles: ['user'], anonymous: false
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
      users[usernameFromToken].online = true;
      users[usernameFromToken].lastSeen = Date.now();
      saveAll();
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
  user.online = true;
  user.lastSeen = Date.now();
  saveAll();
  res.json({ token, user });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const fileUrl = `/${req.file.fieldname === 'avatar' ? 'avatars' : req.file.fieldname === 'sticker' ? 'stickers' : req.file.fieldname === 'voice' ? 'voice' : 'uploads'}/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 
                req.file.mimetype.startsWith('video/') ? 'video' : 
                req.file.mimetype === 'audio/mpeg' ? 'audio' : 'file';
  res.json({ url: fileUrl, type, name: req.file.originalname });
});

// ===== ОПРОСЫ =====
app.post('/api/create-poll', (req, res) => {
  const { token, chatId, question, options, isAnonymous } = req.body;
  const username = sessions[token];
  const pollId = uuidv4();
  polls[pollId] = {
    id: pollId, chatId, question, options: options.map(opt => ({ text: opt, votes: [] })),
    createdBy: username, isAnonymous, createdAt: Date.now(), totalVotes: 0
  };
  saveAll();
  
  const pollMessage = {
    id: uuidv4(),
    from: 'system',
    text: `📊 ОПРОС: ${question}`,
    pollId: pollId,
    pollData: polls[pollId],
    timestamp: Date.now(),
    type: 'poll'
  };
  
  if (!messages[chatId]) messages[chatId] = [];
  messages[chatId].push(pollMessage);
  saveAll();
  
  io.to(chatId).emit('new_poll', { chatId, poll: polls[pollId], message: pollMessage });
  res.json({ success: true, pollId });
});

app.post('/api/vote-poll', (req, res) => {
  const { token, pollId, optionIndex } = req.body;
  const username = sessions[token];
  const poll = polls[pollId];
  if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
  const hasVoted = poll.options.some(opt => opt.votes.includes(username));
  if (hasVoted) return res.status(400).json({ error: 'Вы уже голосовали' });
  poll.options[optionIndex].votes.push(username);
  poll.totalVotes++;
  saveAll();
  io.to(poll.chatId).emit('poll_update', { pollId, options: poll.options, totalVotes: poll.totalVotes });
  res.json({ success: true });
});

// ===== СТИКЕРЫ =====
app.post('/api/create-sticker', upload.single('sticker'), (req, res) => {
  const { token, name } = req.body;
  const username = sessions[token];
  const stickerId = uuidv4();
  const stickerUrl = `/stickers/${req.file.filename}`;
  if (!stickers[username]) stickers[username] = [];
  stickers[username].push({ id: stickerId, name: name || 'sticker', url: stickerUrl, createdAt: Date.now() });
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

// ===== ГРУППЫ =====
app.post('/api/create-group', (req, res) => {
  const { token, name, description } = req.body;
  const creator = sessions[token];
  const groupId = uuidv4();
  groups[groupId] = {
    id: groupId, type: 'group', name, description: description || '', avatar: null, creator,
    members: [creator], admins: [creator], moderators: [], pinnedMessage: null, createdAt: Date.now(),
    invites: []
  };
  saveAll();
  res.json({ success: true, group: groups[groupId] });
});

app.post('/api/create-channel', (req, res) => {
  const { token, name, description } = req.body;
  const creator = sessions[token];
  const channelId = uuidv4();
  channels[channelId] = {
    id: channelId, type: 'channel', name, description: description || '', avatar: null, creator,
    subscribers: [creator], posts: [], createdAt: Date.now()
  };
  saveAll();
  res.json({ success: true, channel: channels[channelId] });
});

app.post('/api/invite-to-group', (req, res) => {
  const { token, groupId, username } = req.body;
  const inviter = sessions[token];
  const group = groups[groupId];
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (!group.admins.includes(inviter)) return res.status(403).json({ error: 'Только админ может приглашать' });
  const cleanUser = cleanUsername(username);
  if (!users[cleanUser]) return res.status(404).json({ error: 'Пользователь не найден' });
  if (!group.invites) group.invites = [];
  if (!group.invites.includes(cleanUser)) group.invites.push(cleanUser);
  saveAll();
  res.json({ success: true });
});

app.post('/api/join-group', (req, res) => {
  const { token, groupId } = req.body;
  const username = sessions[token];
  const group = groups[groupId];
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (group.invites && group.invites.includes(username)) {
    group.members.push(username);
    group.invites = group.invites.filter(i => i !== username);
    saveAll();
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'У вас нет приглашения' });
  }
});

app.get('/api/search', (req, res) => {
  const query = req.query.q?.toLowerCase() || '';
  const cleanQuery = cleanUsername(query);
  const results = Object.values(users).filter(u => !u.isBot && (u.username.toLowerCase().includes(cleanQuery) || u.displayName.toLowerCase().includes(cleanQuery)))
    .map(u => ({ username: u.username, displayName: u.displayName, avatar: u.avatar, online: u.online, lastSeen: u.lastSeen }));
  res.json(results);
});

app.get('/api/search-messages', (req, res) => {
  const { chatId, q } = req.query;
  const chatMessages = messages[chatId] || [];
  const results = chatMessages.filter(m => m.text && m.text.toLowerCase().includes(q.toLowerCase()));
  res.json(results);
});

app.get('/api/chat-stats', (req, res) => {
  const { chatId } = req.query;
  const chatMessages = messages[chatId] || [];
  const userStats = {};
  chatMessages.forEach(msg => { if (!userStats[msg.from]) userStats[msg.from] = 0; userStats[msg.from]++; });
  res.json({ totalMessages: chatMessages.length, userStats, lastActive: chatMessages[chatMessages.length - 1]?.timestamp });
});

app.get('/api/user-status/:username', (req, res) => {
  const user = users[req.params.username];
  if (user) {
    res.json({ online: user.online || false, lastSeen: user.lastSeen, lastSeenFormatted: formatLastSeen(user.lastSeen) });
  } else {
    res.status(404).json({ error: 'Пользователь не найден' });
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

app.post('/api/toggle-anonymous', (req, res) => {
  const { token } = req.body;
  const username = sessions[token];
  users[username].anonymous = !users[username].anonymous;
  saveAll();
  res.json({ success: true, anonymous: users[username].anonymous });
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
      io.to(chatId).emit('message_edited', { chatId, messageId, newText });
      res.json({ success: true });
    }
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
        if (forEveryone) messages[chatId].splice(messageIndex, 1);
        else {
          message.deletedFor = message.deletedFor || [];
          message.deletedFor.push(username);
          message.text = '[Сообщение удалено]';
          message.attachments = [];
        }
        saveAll();
        io.to(chatId).emit('message_deleted', { chatId, messageId, forEveryone });
        res.json({ success: true });
      }
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
      io.to(chatId).emit('message_pinned', { chatId, messageId, pinned: message.pinned });
      res.json({ success: true, pinned: message.pinned });
    }
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

io.on('connection', (socket) => {
  const username = socket.username;
  console.log(`✅ ${username} подключился`);
  
  if (users[username]) {
    users[username].online = true;
    users[username].lastSeen = Date.now();
    saveAll();
    io.emit('user_status_change', { username, online: true, lastSeen: users[username].lastSeen, lastSeenFormatted: formatLastSeen(users[username].lastSeen) });
  }
  
  socket.join(username);
  
  const userGroups = Object.values(groups).filter(g => g.members.includes(username));
  const userChannels = Object.values(channels).filter(c => c.subscribers.includes(username));
  const userDMs = [];
  
  Object.keys(messages).forEach(chatId => {
    if (chatId.includes(username)) {
      const other = chatId.replace(username, '').replace(/_/g, '');
      if (other && users[other]) {
        userDMs.push({ id: chatId, type: 'dm', with: other, lastMessage: messages[chatId][messages[chatId].length - 1] });
      }
    }
  });
  
  socket.emit('init', { user: users[username], chats: [...userDMs, ...userGroups, ...userChannels], stickers: stickers[username] || [] });
  
  socket.on('send_message', (data) => {
    const { to, type, text, attachments, replyTo } = data;
    console.log(`📨 Сообщение от ${username} для ${to} (${type}): "${text}"`);
    
    const displayFrom = users[username]?.anonymous ? 'Аноним' : username;
    const message = {
      id: uuidv4(),
      from: displayFrom,
      realFrom: username,
      to: to,
      text: text,
      attachments: attachments || [],
      replyTo: replyTo || null,
      timestamp: Date.now(),
      type: type,
      read: false,
      edited: false,
      pinned: false
    };
    
    let chatId;
    
    if (type === 'dm') {
      chatId = [username, to].sort().join('_');
      if (!messages[chatId]) messages[chatId] = [];
      messages[chatId].push(message);
      saveAll();
      
      socket.emit('new_message', message);
      io.to(to).emit('new_message', message);
      console.log(`📤 Сообщение отправлено получателю ${to}`);
    }
    else if (type === 'group') {
      const group = groups[to];
      if (group && group.members.includes(username)) {
        chatId = to;
        if (!messages[chatId]) messages[chatId] = [];
        messages[chatId].push(message);
        saveAll();
        
        socket.emit('new_message', message);
        group.members.forEach(member => {
          if (member !== username) {
            io.to(member).emit('new_message', message);
          }
        });
      }
    }
    else if (type === 'channel') {
      const channel = channels[to];
      if (channel && channel.subscribers.includes(username)) {
        chatId = to;
        if (!messages[chatId]) messages[chatId] = [];
        messages[chatId].push(message);
        saveAll();
        
        socket.emit('new_message', message);
        channel.subscribers.forEach(sub => {
          if (sub !== username) {
            io.to(sub).emit('new_message', message);
          }
        });
      }
    }
  });
  
  socket.on('load_chat', ({ chatId }) => {
    const history = messages[chatId] || [];
    console.log(`📜 Загрузка истории чата ${chatId}, сообщений: ${history.length}`);
    socket.emit('chat_history', { chatId, messages: history });
  });
  
  socket.on('get_user_status', ({ username: targetUsername }) => {
    const user = users[targetUsername];
    if (user) {
      socket.emit('user_status', { username: targetUsername, online: user.online || false, lastSeen: user.lastSeen, lastSeenFormatted: formatLastSeen(user.lastSeen) });
    }
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
    console.log(`❌ ${username} отключился`);
  });
});

setInterval(() => saveAll(), 5000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('💜💚 POTATUIKA ЗАПУЩЕН!');
  console.log(`📍 http://localhost:${PORT}`);
  console.log('✨ Все данные сохраняются в папке data/');
});