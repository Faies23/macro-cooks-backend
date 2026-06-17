require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: process.env.APP_ORIGIN || '*' }));
// Capture the raw body so payment webhooks can verify their signature.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'macro-cooks-backend', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/profile', require('./routes/profile.routes'));
app.use('/api/payments', require('./routes/payments.routes'));
app.use('/api/content', require('./routes/content.routes'));

// Minimal admin dashboard for testing uploads.
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Macro Cooks backend listening on :' + port));
