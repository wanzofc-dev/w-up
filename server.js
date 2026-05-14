require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const dns = require('dns');
const cookieParser = require('cookie-parser');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const csurf = require('csurf');
const SystemConfig = require('./models/systemConfig');
const File = require('./models/file');
const { loadSystemConfig } = require('./middleware/system');
const { languages } = require('./utils/tr');

const mongoUri = process.env.MONGO_URI || '';
if (mongoUri.startsWith('mongodb+srv://')) {
  const dnsServers = (process.env.MONGO_DNS_SERVERS || '1.1.1.1,8.8.8.8')
    .split(',')
    .map(server => server.trim())
    .filter(Boolean);

  if (dnsServers.length > 0) {
    dns.setServers(dnsServers);
  }
}

const app = express();

async function reconcileMongoIndexes() {
  try {
    const indexes = await File.collection.indexes();
    const legacyShareLinkIndex = indexes.find(index => index.name === 'shareLinks.linkId_1');

    if (legacyShareLinkIndex) {
      await File.collection.dropIndex('shareLinks.linkId_1');
      console.log('Dropped legacy Mongo index: shareLinks.linkId_1');
    }
  } catch (error) {
    console.error('Mongo index reconciliation warning:', error.message);
  }
}

const authRoutes = require('./routes/auth');
const viewRoutes = require('./routes/view');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai'); 
const reqRoutes = require('./routes/req'); 
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "cdnjs.cloudflare.com", 
        "cdn.plyr.io", 
        "cdn.jsdelivr.net", 
        "app.midtrans.com",
        "app.sandbox.midtrans.com",
        "pagead2.googlesyndication.com",
        "partner.googleadservices.com",
        "www.googletagservices.com",
        "tpc.googlesyndication.com"
      ],
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "cdnjs.cloudflare.com", 
        "cdn.plyr.io", 
        "fonts.googleapis.com"
      ],
      fontSrc: ["'self'", "cdnjs.cloudflare.com", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "*"], 
      mediaSrc: ["'self'", "data:", "blob:"],
      frameSrc: [
        "'self'", 
        "app.midtrans.com",
        "app.sandbox.midtrans.com",
        "docs.google.com", 
        "googleads.g.doubleclick.net", 
        "tpc.googlesyndication.com",
        "www.google.com"
      ],
      connectSrc: [
        "'self'",
        "app.midtrans.com",
        "app.sandbox.midtrans.com",
        "api.midtrans.com",
        "api.sandbox.midtrans.com",
        "pagead2.googlesyndication.com"
      ],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.APP_URL || 'https://wanzofc.site', 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-CSRF-Token']
}));

app.use(hpp());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/robots.txt', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB Connection Error:', err);
});

mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 })
  .then(async () => {
    console.log('MongoDB Connected');
    await reconcileMongoIndexes();
  })
  .catch(err => console.error('MongoDB Initial Connection Error:', err));

const csrfProtection = csurf({ cookie: true });

app.use((req, res, next) => {
  if (req.headers['x-api-key'] || req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) {
    return next();
  }
  csrfProtection(req, res, next);
});

app.use((req, res, next) => {
  res.locals.currentUrl = req.originalUrl;
  res.locals.availableLanguages = languages;
  res.locals.defaultLanguage = 'original';
  if (req.csrfToken) {
    res.locals.csrfToken = req.csrfToken();
  }
  next();
});

app.use(loadSystemConfig);

app.get('/ads.txt', async (req, res) => {
    try {
        const config = await SystemConfig.getConfig();
        res.set('Content-Type', 'text/plain');
        res.send(config.adsTxtContent || '');
    } catch (e) {
        res.status(500).send('Error loading ads.txt');
    }
});

app.use('/api/auth', authRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/request', reqRoutes);
app.use('/', viewRoutes);

app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ status: 'error', message: 'Invalid or missing CSRF Token' });
  }
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

module.exports = app;
