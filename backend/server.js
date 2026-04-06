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
app.use('/music', express.static('music'));
app.use(express.static(path.join(__dirname, '../frontend')));

['uploads', 'avatars', 'stickers', 'data', 'voice', 'music'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

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
let scheduledMessages = loadData('scheduled.json');
let musicPlaylists = loadData('playlists.json');
let cloudFiles = loadData('cloud.json');
let games = loadData('games.json');

const saveAll = () => {
  saveData('users.json', users);
  saveData('messages.json', messages);
  saveData('groups.json', groups);
  saveData('channels.json', channels);
  saveData('sessions.json', sessions);
  saveData('stickers.json', stickers);
  saveData('polls.json', polls);
  saveData('scheduled.json', scheduledMessages);
  saveData('playlists.json', musicPlaylists);
  saveData('cloud.json', cloudFiles);
  saveData('games.json', games);
  console.log('💾 Все данные сохранены');
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads';
    if (file.fieldname === 'avatar') folder = 'avatars';
    if (file.fieldname === 'sticker') folder = 'stickers';
    if (file.fieldname === 'voice') folder = 'voice';
    if (file.fieldname === 'music') folder = 'music';
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
  const fileUrl = `/${req.file.fieldname === 'avatar' ? 'avatars' : req.file.fieldname === 'sticker' ? 'stickers' : req.file.fieldname === 'voice' ? 'voice' : req.file.fieldname === 'music' ? 'music' : 'uploads'}/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 
                req.file.mimetype.startsWith('video/') ? 'video' : 
                req.file.mimetype === 'audio/mpeg' || req.file.fieldname === 'music' ? 'music' : 'file';
  res.json({ url: fileUrl, type, name: req.file.originalname });
});

// ===== ОПРОСЫ (БЕСПЛАТНО) =====
app.post('/api/create-poll', (req, res) => {
  const { token, chatId, question, options, isAnonymous } = req.body;
  const username = sessions[token];
  const pollId = uuidv4();
  polls[pollId] = {
    id: pollId, chatId, question, options: options.map(opt => ({ text: opt, votes: [] })),
    createdBy: username, isAnonymous, createdAt: Date.now(), totalVotes: 0
  };
  saveAll();
  io.emit('new_poll', { chatId, poll: polls[pollId] });
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
  io.emit('poll_update', { pollId, options: poll.options, totalVotes: poll.totalVotes });
  res.json({ success: true });
});

// ===== ОТЛОЖЕННЫЕ СООБЩЕНИЯ =====
app.post('/api/schedule-message', (req, res) => {
  const { token, to, type, text, scheduleTime } = req.body;
  const from = sessions[token];
  const scheduledId = uuidv4();
  scheduledMessages[scheduledId] = {
    id: scheduledId, from, to, type, text, scheduleTime, status: 'pending'
  };
  saveAll();
  res.json({ success: true, scheduledId });
});

// ===== МУЗЫКАЛЬНЫЙ ПЛЕЕР =====
app.post('/api/create-playlist', (req, res) => {
  const { token, name, songs } = req.body;
  const username = sessions[token];
  const playlistId = uuidv4();
  if (!musicPlaylists[username]) musicPlaylists[username] = [];
  musicPlaylists[username].push({ id: playlistId, name, songs, createdAt: Date.now() });
  saveAll();
  res.json({ success: true, playlistId });
});

app.get('/api/get-playlists', (req, res) => {
  const { token } = req.query;
  const username = sessions[token];
  res.json(musicPlaylists[username] || []);
});

// ===== РОЛИ И ПРАВА (БЕСПЛАТНО) =====
app.post('/api/set-role', (req, res) => {
  const { token, groupId, targetUsername, role } = req.body;
  const admin = sessions[token];
  const group = groups[groupId];
  if (!group || !group.admins.includes(admin)) return res.status(403).json({ error: 'Нет прав' });
  const cleanTarget = cleanUsername(targetUsername);
  if (role === 'admin') {
    if (!group.admins.includes(cleanTarget)) group.admins.push(cleanTarget);
  }
  if (role === 'moderator') {
    if (!group.moderators) group.moderators = [];
    if (!group.moderators.includes(cleanTarget)) group.moderators.push(cleanTarget);
  }
  if (role === 'remove_admin') {
    group.admins = group.admins.filter(a => a !== cleanTarget);
  }
  if (role === 'remove_moderator') {
    group.moderators = group.moderators.filter(m => m !== cleanTarget);
  }
  saveAll();
  res.json({ success: true });
});

// ===== КАНАЛЫ =====
app.post('/api/post-to-channel', (req, res) => {
  const { token, channelId, text, attachments } = req.body;
  const username = sessions[token];
  const channel = channels[channelId];
  if (!channel || !channel.subscribers.includes(username)) return res.status(403).json({ error: 'Не подписан' });
  const post = { id: uuidv4(), from: username, text, attachments, timestamp: Date.now(), views: 0 };
  if (!channel.posts) channel.posts = [];
  channel.posts.push(post);
  saveAll();
  io.emit('new_post', { channelId, post });
  res.json({ success: true, post });
});

// ===== ССЫЛКИ-ПРИГЛАШЕНИЯ =====
app.post('/api/create-invite', (req, res) => {
  const { token, groupId } = req.body;
  const username = sessions[token];
  const group = groups[groupId];
  if (!group || !group.members.includes(username)) return res.status(403).json({ error: 'Нет прав' });
  const inviteLink = `${uuidv4().substring(0, 8)}`;
  if (!group.invites) group.invites = [];
  group.invites.push({ link: inviteLink, createdBy: username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  saveAll();
  res.json({ success: true, link: inviteLink });
});

app.post('/api/join-by-link', (req, res) => {
  const { token, groupId, link } = req.body;
  const username = sessions[token];
  const group = groups[groupId];
  const validInvite = group.invites?.find(i => i.link === link && i.expiresAt > Date.now());
  if (!validInvite) return res.status(403).json({ error: 'Недействительная ссылка' });
  if (!group.members.includes(username)) group.members.push(username);
  saveAll();
  res.json({ success: true });
});

// ===== АНОНИМНЫЙ РЕЖИМ =====
app.post('/api/toggle-anonymous', (req, res) => {
  const { token } = req.body;
  const username = sessions[token];
  users[username].anonymous = !users[username].anonymous;
  saveAll();
  res.json({ success: true, anonymous: users[username].anonymous });
});

// ===== СТАТИСТИКА ЧАТА =====
app.get('/api/chat-stats', (req, res) => {
  const { chatId } = req.query;
  const chatMessages = messages[chatId] || [];
  const userStats = {};
  chatMessages.forEach(msg => {
    if (!userStats[msg.from]) userStats[msg.from] = 0;
    userStats[msg.from]++;
  });
  const hours = {};
  chatMessages.forEach(msg => {
    const hour = new Date(msg.timestamp).getHours();
    hours[hour] = (hours[hour] || 0) + 1;
  });
  res.json({ totalMessages: chatMessages.length, userStats, hourlyStats: hours, lastActive: chatMessages[chatMessages.length - 1]?.timestamp });
});

// ===== КАСТОМНЫЕ ТЕМЫ =====
app.post('/api/custom-theme', (req, res) => {
  const { token, theme } = req.body;
  const username = sessions[token];
  users[username].customTheme = theme;
  saveAll();
  res.json({ success: true });
});

// ===== ОБЛАЧНОЕ ХРАНИЛИЩЕ (1 ГБ БЕСПЛАТНО) =====
app.post('/api/cloud-upload', upload.single('file'), (req, res) => {
  const { token } = req.body;
  const username = sessions[token];
  if (!cloudFiles[username]) cloudFiles[username] = [];
  const totalSize = cloudFiles[username].reduce((sum, f) => sum + f.size, 0);
  if (totalSize + req.file.size > 1024 * 1024 * 1024) {
    return res.status(400).json({ error: 'Превышен лимит 1 ГБ' });
  }
  cloudFiles[username].push({ id: uuidv4(), name: req.file.originalname, url: `/uploads/${req.file.filename}`, size: req.file.size, date: Date.now() });
  saveData('cloud.json', cloudFiles);
  res.json({ success: true, files: cloudFiles[username] });
});

app.get('/api/cloud-files', (req, res) => {
  const { token } = req.query;
  const username = sessions[token];
  res.json(cloudFiles[username] || []);
});

app.delete('/api/cloud-delete', (req, res) => {
  const { token, fileId } = req.body;
  const username = sessions[token];
  if (cloudFiles[username]) {
    cloudFiles[username] = cloudFiles[username].filter(f => f.id !== fileId);
    saveData('cloud.json', cloudFiles);
  }
  res.json({ success: true });
});

// ===== ИГРЫ (БЕСПЛАТНО) =====
let activeGames = loadData('active_games.json');

app.post('/api/create-game', (req, res) => {
  const { token, chatId, gameType } = req.body;
  const username = sessions[token];
  const gameId = uuidv4();
  if (!activeGames[chatId]) activeGames[chatId] = {};
  activeGames[chatId][gameId] = {
    id: gameId, type: gameType, players: [username], status: 'waiting', data: {},
    createdAt: Date.now(), currentTurn: username
  };
  saveData('active_games.json', activeGames);
  io.emit('game_update', { chatId, game: activeGames[chatId][gameId] });
  res.json({ success: true, gameId });
});

app.post('/api/game-move', (req, res) => {
  const { token, chatId, gameId, move } = req.body;
  const username = sessions[token];
  const game = activeGames[chatId]?.[gameId];
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  if (game.currentTurn !== username) return res.status(403).json({ error: 'Не ваш ход' });
  game.data[move] = username;
  game.currentTurn = game.players.find(p => p !== username);
  saveData('active_games.json', activeGames);
  io.emit('game_update', { chatId, game });
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

// ===== ГРУППЫ И КАНАЛЫ =====
app.post('/api/create-group', (req, res) => {
  const { token, name, description } = req.body;
  const creator = sessions[token];
  const groupId = uuidv4();
  groups[groupId] = {
    id: groupId, type: 'group', name, description: description || '', avatar: null, creator,
    members: [creator], admins: [creator], moderators: [], pinnedMessage: null, createdAt: Date.now(),
    invites: [], customRules: ''
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
      io.emit('message_edited', { chatId, messageId, newText });
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
        io.emit('message_deleted', { chatId, messageId, forEveryone });
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
      io.emit('message_pinned', { chatId, messageId, pinned: message.pinned });
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
  
  const userGroups = Object.values(groups).filter(g => g.members.includes(username));
  const userChannels = Object.values(channels).filter(c => c.subscribers.includes(username));
  const userDMs = [];
  Object.keys(messages).forEach(chatId => {
    if (chatId.includes(username)) {
      const other = chatId.replace(username, '').replace(/_/g, '');
      if (other && users[other]) userDMs.push({ id: chatId, type: 'dm', with: other, lastMessage: messages[chatId][messages[chatId].length - 1] });
    }
  });
  
  socket.emit('init', { user: users[username], chats: [...userDMs, ...userGroups, ...userChannels], stickers: stickers[username] || [] });
  
  // Проверка отложенных сообщений каждую минуту
  setInterval(() => {
    const now = Date.now();
    Object.entries(scheduledMessages).forEach(([id, msg]) => {
      if (msg.status === 'pending' && msg.scheduleTime <= now) {
        msg.status = 'sent';
        const message = { id: uuidv4(), from: msg.from, to: msg.to, text: msg.text, attachments: [], timestamp: Date.now(), type: msg.type, scheduled: true };
        const chatId = [msg.from, msg.to].sort().join('_');
        if (!messages[chatId]) messages[chatId] = [];
        messages[chatId].push(message);
        const recipientSocket = [...io.sockets.sockets.values()].find(s => s.username === msg.to);
        if (recipientSocket) recipientSocket.emit('new_message', message);
        saveAll();
      }
    });
  }, 60000);
  
  socket.on('send_message', (data) => {
    const { to, type, text, attachments, replyTo } = data;
    const displayFrom = users[username]?.anonymous ? 'Аноним' : username;
    const message = {
      id: uuidv4(), from: displayFrom, realFrom: username, to, text, attachments: attachments || [],
      replyTo: replyTo || null, timestamp: Date.now(), type, read: false, edited: false, pinned: false
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
    } else if (type === 'group') {
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
    } else if (type === 'channel') {
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
  
  socket.on('load_chat', ({ chatId }) => {
    socket.emit('chat_history', { chatId, messages: messages[chatId] || [] });
  });
  
  socket.on('get_user_status', ({ username: targetUsername }) => {
    const user = users[targetUsername];
    if (user) socket.emit('user_status', { username: targetUsername, online: user.online || false, lastSeen: user.lastSeen, lastSeenFormatted: formatLastSeen(user.lastSeen) });
  });
  
  socket.on('typing', ({ chatId, isTyping }) => {
    socket.broadcast.emit('user_typing', { username, chatId, isTyping });
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

setInterval(() => saveAll(), 10000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('💜💚 POTATUIKA БЕСПЛАТНЫЙ МЕССЕНДЖЕР ЗАПУЩЕН!');
  console.log(`📍 http://localhost:${PORT}`);
  console.log('✨ ВСЕ ФИЧИ БЕСПЛАТНЫ:');
  console.log('  🎵 Музыкальный плеер');
  console.log('  🗳️ Опросы');
  console.log('  👑 Роли и права');
  console.log('  🔗 Пригласительные ссылки');
  console.log('  🎭 Анонимный режим');
  console.log('  📊 Статистика чата');
  console.log('  🎨 Кастомные темы');
  console.log('  📎 Облачное хранилище (1 ГБ)');
  console.log('  ⏰ Отложенные сообщения');
  console.log('  🎮 Игры');
  console.log('  🤖 Боты (в разработке)');
});