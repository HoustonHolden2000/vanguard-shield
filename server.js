const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const USERS = {
  admin: { password: 'vanguard2026', role: 'admin', name: 'Admin' },
  guard: { password: 'guard123', role: 'guard', name: 'Guard' },
  demo:  { password: 'demo', role: 'demo', name: 'Demo User' }
};

let scans = [];

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (user && user.password === password) {
    return res.json({ success: true, role: user.role, name: user.name });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/scans', (req, res) => {
  const scan = { id: Date.now(), timestamp: new Date().toISOString(), ...req.body };
  scans.unshift(scan);
  if (scans.length > 500) scans = scans.slice(0, 500);
  res.json({ success: true, scan });
});

app.get('/api/scans', (req, res) => {
  res.json({ scans: scans.slice(0, 50) });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '4.0.0', engine: 'dynamsoft-v11' });
});

app.listen(PORT, () => {
  console.log('Iron Halo Verify v4.0 running on port ' + PORT);
});
