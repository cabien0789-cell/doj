const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'doj-secret-key',
  resave: true,
  rolling: true,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 24 * 60 * 60 * 1000 }
}));

const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
  await client.connect();
  db = client.db('doj');
  await db.collection('submissions').createIndex({ username: 1, problemId: 1, submittedAt: -1 });
  await db.collection('solves').createIndex({ username: 1, problemId: 1 }, { unique: true });
  await db.collection('solves').createIndex({ problemId: 1 });
  await db.collection('solves').createIndex({ username: 1 });
  await db.collection('problems').createIndex({ featured: 1 });
  await db.collection('problems').createIndex({ author: 1 });
  await db.collection('notifications').createIndex({ username: 1 });
  await db.collection('notifications').createIndex({ username: 1, createdAt: -1 });
  await db.collection('submissions').deleteMany({ status: 'pending' });
  console.log('Connected to MongoDB');
}

function getUsers() { return db.collection('users'); }
function getProblems() { return db.collection('problems'); }
function getOrgs() { return db.collection('organizations'); }
function getContests() { return db.collection('contests'); }
function getSubmissions() { return db.collection('submissions'); }
function getSolves() { return db.collection('solves'); }
function getNotifications() { return db.collection('notifications'); }

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.redirect('/');
  next();
}

function requireOrg(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'org' && req.session.user.role !== 'admin') return res.redirect('/organizations');
  next();
}

// ─── RATE LIMIT ───────────────────────────────────────────
const submitRateLimit = new Map();

function checkSubmitRateLimit(username) {
  const now = Date.now();
  const windowMs = 2 * 60 * 1000;
  const maxSubmits = 4;
  if (!submitRateLimit.has(username)) submitRateLimit.set(username, []);
  const timestamps = submitRateLimit.get(username).filter(t => now - t < windowMs);
  if (timestamps.length >= maxSubmits) return false;
  timestamps.push(now);
  submitRateLimit.set(username, timestamps);
  return true;
}

// ─── JUDGE CONCURRENCY CONTROL ────────────────────────────
const MAX_CPP_CONCURRENT = 2;
const MAX_TOTAL_POINTS = 6;
const CPP_POINTS = 2;
const SCRIPT_POINTS = 1;

let currentCppCount = 0;
let currentTotalPoints = 0;
const cppQueue = [];
const scriptQueue = [];

function isCppLanguage(language) {
  return language === 'cpp' || language === 'c';
}

function tryDispatch() {
  while (cppQueue.length > 0 && currentCppCount < MAX_CPP_CONCURRENT && currentTotalPoints + CPP_POINTS <= MAX_TOTAL_POINTS) {
    const task = cppQueue.shift();
    currentCppCount++;
    currentTotalPoints += CPP_POINTS;
    runJudgeTask(task);
  }
  while (scriptQueue.length > 0 && currentTotalPoints + SCRIPT_POINTS <= MAX_TOTAL_POINTS) {
    const task = scriptQueue.shift();
    currentTotalPoints += SCRIPT_POINTS;
    runJudgeTask(task);
  }
}

async function runJudgeTask(task) {
  try {
    const result = await judgeCodeAsync(task.code, task.language, task.testcases, task.timeLimit);
    await saveJudgeResult(task, result);
  } catch (e) {
    console.error('Judge error:', e.message);
    await saveJudgeError(task);
  } finally {
    if (isCppLanguage(task.language)) {
      currentCppCount--;
      currentTotalPoints -= CPP_POINTS;
    } else {
      currentTotalPoints -= SCRIPT_POINTS;
    }
    tryDispatch();
  }
}

async function saveJudgeResult(task, result) {
  const now = new Date().toISOString();
  await getSubmissions().updateOne(
    { _id: new ObjectId(task.submissionId) },
    {
      $set: {
        verdict: result.verdict, passedCount: result.passedCount,
        total: result.total, execTime: result.execTime,
        submittedAt: now, status: 'done', result
      }
    }
  );
  const allMySubs = await getSubmissions().find(
    { username: task.username, problemId: task.problemId, status: 'done' },
    { projection: { _id: 1 } }
  ).sort({ submittedAt: -1 }).toArray();
  if (allMySubs.length > 5) {
    const toDelete = allMySubs.slice(5).map(s => s._id);
    await getSubmissions().deleteMany({ _id: { $in: toDelete } });
  }
  if (result.verdict === 'Accepted') {
    await getSolves().updateOne(
      { username: task.username, problemId: task.problemId },
      { $setOnInsert: { username: task.username, problemId: task.problemId, solvedAt: now } },
      { upsert: true }
    );
  }
}

async function saveJudgeError(task) {
  await getSubmissions().updateOne(
    { _id: new ObjectId(task.submissionId) },
    { $set: { status: 'done', verdict: 'Runtime Error', passedCount: 0, total: 0, execTime: 0, result: { verdict: 'Runtime Error', passedCount: 0, total: 0, details: [], execTime: 0 } } }
  );
}

function submitToJudge(task) {
  if (isCppLanguage(task.language)) {
    if (currentCppCount < MAX_CPP_CONCURRENT && currentTotalPoints + CPP_POINTS <= MAX_TOTAL_POINTS) {
      currentCppCount++;
      currentTotalPoints += CPP_POINTS;
      runJudgeTask(task);
    } else {
      cppQueue.push(task);
    }
  } else {
    if (currentTotalPoints + SCRIPT_POINTS <= MAX_TOTAL_POINTS) {
      currentTotalPoints += SCRIPT_POINTS;
      runJudgeTask(task);
    } else {
      scriptQueue.push(task);
    }
  }
}

// ─── DELETE PROBLEM AND RELATED ───────────────────────────
async function deleteProblemAndRelated(problemId) {
  const pid = problemId.toString();
  await getProblems().deleteOne({ _id: new ObjectId(pid) });
  await getSubmissions().deleteMany({ problemId: pid });
  await getSolves().deleteMany({ problemId: pid });
  await getContests().updateMany({ problemIds: pid }, { $pull: { problemIds: pid } });
}

function emailTemplate(bodyContent) {
  return `
  <div style="background:#f4f4f4; padding:40px 20px; font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:12px; overflow:hidden;">
      <div style="background:#0f0f23; padding:28px 32px; text-align:center;">
        <div style="color:#00e5a0; font-size:28px; font-weight:800; letter-spacing:2px; font-family:'Segoe UI',Arial,sans-serif; line-height:1.2;">Dary</div>
        <div style="color:#a0a0b0; font-size:13px; font-weight:400; letter-spacing:3px; text-transform:uppercase; font-family:'Segoe UI',Arial,sans-serif; margin-top:4px;">Online Judge</div>
      </div>
      <div style="padding:32px 32px 24px;">${bodyContent}</div>
      <div style="background:#f8f9ff; padding:20px 32px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="text-align:center; padding:0 8px;">
              <div style="font-size:18px; margin-bottom:4px;">💻</div>
              <div style="font-size:12px; font-weight:600; color:#0f0f23; font-family:'Segoe UI',Arial,sans-serif;">Luyện tập</div>
              <div style="font-size:11px; color:#888; font-family:'Segoe UI',Arial,sans-serif;">Hàng trăm bài tập</div>
            </td>
            <td style="text-align:center; padding:0 8px;">
              <div style="font-size:18px; margin-bottom:4px;">🏆</div>
              <div style="font-size:12px; font-weight:600; color:#0f0f23; font-family:'Segoe UI',Arial,sans-serif;">Thi đấu</div>
              <div style="font-size:11px; color:#888; font-family:'Segoe UI',Arial,sans-serif;">Contest hàng tuần</div>
            </td>
            <td style="text-align:center; padding:0 8px;">
              <div style="font-size:18px; margin-bottom:4px;">📈</div>
              <div style="font-size:12px; font-weight:600; color:#0f0f23; font-family:'Segoe UI',Arial,sans-serif;">Tiến bộ</div>
              <div style="font-size:11px; color:#888; font-family:'Segoe UI',Arial,sans-serif;">Theo dõi kết quả</div>
            </td>
          </tr>
        </table>
      </div>
      <div style="background:#0f0f23; padding:18px 32px; text-align:center;">
        <p style="margin:0; color:#a0a0b0; font-size:12px; line-height:1.8; font-family:'Segoe UI',Arial,sans-serif;">
          © 2026 Dary Online Judge · All rights reserved<br>
          <a href="https://doj-60st.onrender.com" style="color:#00e5a0; text-decoration:none;">doj-60st.onrender.com</a>
        </p>
      </div>
    </div>
  </div>`;
}

async function sendEmail(to, subject, htmlContent) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'DOJ - Dary Online Judge', email: process.env.GMAIL_USER },
      to: [{ email: to }], subject, htmlContent
    })
  });
  if (!response.ok) throw new Error(await response.text());
}

async function sendNotification(username, message) {
  await getNotifications().insertOne({ username, message, read: false, createdAt: new Date().toISOString() });
  const all = await getNotifications().find({ username }).sort({ createdAt: -1 }).toArray();
  if (all.length > 8) {
    const toDelete = all.slice(8).map(n => n._id);
    await getNotifications().deleteMany({ _id: { $in: toDelete } });
  }
}

function toUTC(datetimeLocal, timezone) {
  if (!datetimeLocal) return null;
  const clean = datetimeLocal.slice(0, 16);
  if (timezone === 'Vietnam') return new Date(clean + ':00+07:00').toISOString();
  return new Date(clean + ':00Z').toISOString();
}

function validateContestTime(startTimeUTC, endTimeUTC) {
  const now = new Date();
  const start = new Date(startTimeUTC);
  const end = new Date(endTimeUTC);
  const minStart = new Date(now.getTime() + 15 * 60000);
  const minEndFromStart = new Date(start.getTime() + 15 * 60000);
  if (start < minStart) return 'Start time must be at least 15 minutes from now.';
  if (end < minEndFromStart) return 'End time must be at least 15 minutes after start time.';
  return null;
}

function getServerTime() {
  const now = new Date();
  const utcStr = now.toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)';
  const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const vnStr = vnTime.toISOString().slice(0, 16).replace('T', ' ') + ' (Vietnam UTC+7)';
  return { utc: utcStr, vietnam: vnStr };
}

function normalizeOutput(str) {
  const lines = str.split('\n');
  const rstripped = lines.map(line => line.replace(/\s+$/, ''));
  while (rstripped.length > 0 && rstripped[rstripped.length - 1] === '') rstripped.pop();
  return rstripped.join('\n');
}

function makeTmpDir() {
  const tmpBase = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpBase)) fs.mkdirSync(tmpBase);
  const id = Date.now() + '_' + (++tmpDirCounter) + '_' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(tmpBase, id);
  fs.mkdirSync(dir);
  return dir;
}

let tmpDirCounter = 0;

function removeTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

function runProcessAsync(cmd, args, inputData, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill('SIGKILL'); } catch (e) {}
        resolve({ timedOut: true, stdout: '', stderr: '' });
      }
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code, stdout, stderr });
      }
    });

    proc.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code: 1, stdout: '', stderr: err.message });
      }
    });

    if (inputData) proc.stdin.write(inputData);
    proc.stdin.end();
  });
}

async function judgeCodeAsync(code, language, testcases, timeLimit) {
  const tmpDir = makeTmpDir();
  const timeLimitMs = (timeLimit || 2) * 1000;
  const details = [];
  let passedCount = 0;
  let compiledPath = null;

  try {
    if (language === 'cpp') {
      const codeFile = path.join(tmpDir, 'solution.cpp');
      const outFile = path.join(tmpDir, 'solution');
      fs.writeFileSync(codeFile, code);
      const compileResult = await runProcessAsync('g++', ['-o', outFile, codeFile], null, 30000);
      if (compileResult.code !== 0) {
        const errMsg = compileResult.stderr || 'Compilation Error';
        for (let i = 0; i < testcases.length; i++)
          details.push({ status: 'CE', passed: false, output: errMsg, expected: '' });
        removeTmpDir(tmpDir);
        return { verdict: 'Compilation Error', passed: false, passedCount: 0, total: testcases.length, details };
      }
      compiledPath = outFile;
    } else if (language === 'c') {
      const codeFile = path.join(tmpDir, 'solution.c');
      const outFile = path.join(tmpDir, 'solutionc');
      fs.writeFileSync(codeFile, code);
      const compileResult = await runProcessAsync('gcc', ['-o', outFile, codeFile], null, 30000);
      if (compileResult.code !== 0) {
        const errMsg = compileResult.stderr || 'Compilation Error';
        for (let i = 0; i < testcases.length; i++)
          details.push({ status: 'CE', passed: false, output: errMsg, expected: '' });
        removeTmpDir(tmpDir);
        return { verdict: 'Compilation Error', passed: false, passedCount: 0, total: testcases.length, details };
      }
      compiledPath = outFile;
    }
  } catch (e) {
    const errMsg = e.message || 'Compilation Error';
    for (let i = 0; i < testcases.length; i++)
      details.push({ status: 'CE', passed: false, output: errMsg, expected: '' });
    removeTmpDir(tmpDir);
    return { verdict: 'Compilation Error', passed: false, passedCount: 0, total: testcases.length, details };
  }

  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    if (!tc.input || !tc.output) {
      details.push({ status: 'WA', passed: false, output: '', expected: '' });
      continue;
    }
    const startTime = Date.now();
    try {
      let runResult;
      if (language === 'python') {
        const codeFile = path.join(tmpDir, 'solution.py');
        fs.writeFileSync(codeFile, code);
        runResult = await runProcessAsync('python3', [codeFile], tc.input, timeLimitMs);
      } else if (language === 'cpp' || language === 'c') {
        runResult = await runProcessAsync(compiledPath, [], tc.input, timeLimitMs);
      } else if (language === 'javascript') {
        const codeFile = path.join(tmpDir, 'solution.js');
        fs.writeFileSync(codeFile, code);
        runResult = await runProcessAsync('node', [codeFile], tc.input, timeLimitMs);
      }
      const execTime = Date.now() - startTime;
      if (runResult.timedOut) {
        details.push({ status: 'TLE', passed: false, output: '', expected: '', execTime });
      } else if (runResult.code !== 0) {
        details.push({ status: 'RE', passed: false, output: runResult.stderr ? runResult.stderr.split('\n')[0] : 'Runtime Error', expected: '', execTime });
      } else {
        const normalizedOutput = normalizeOutput(runResult.stdout);
        const normalizedExpected = normalizeOutput(tc.output);
        const passed = normalizedOutput === normalizedExpected;
        if (passed) passedCount++;
        details.push({ status: passed ? 'AC' : 'WA', passed, output: '', expected: '', execTime });
      }
    } catch (e) {
      const execTime = Date.now() - startTime;
      details.push({ status: 'RE', passed: false, output: e.message || 'Runtime Error', expected: '', execTime });
    }
  }

  removeTmpDir(tmpDir);
  const allPassed = passedCount === testcases.length;
  let verdict = 'Accepted';
  if (!allPassed) {
    const firstFail = details.find(d => !d.passed);
    if (firstFail) verdict = firstFail.status === 'TLE' ? 'Time Limit Exceeded' : firstFail.status === 'RE' ? 'Runtime Error' : firstFail.status === 'CE' ? 'Compilation Error' : 'Wrong Answer';
  }
  return { verdict, passed: allPassed, passedCount, total: testcases.length, details, execTime: Math.max(...details.map(d => d.execTime || 0)) };
}

async function runCodeOnce(code, language, input) {
  const tmpDir = makeTmpDir();
  try {
    let compiledPath = null;
    if (language === 'cpp') {
      const codeFile = path.join(tmpDir, 'solution.cpp');
      const outFile = path.join(tmpDir, 'solution');
      fs.writeFileSync(codeFile, code);
      const compileResult = await runProcessAsync('g++', ['-o', outFile, codeFile], null, 30000);
      if (compileResult.code !== 0) {
        removeTmpDir(tmpDir);
        return { error: compileResult.stderr || 'Compilation Error' };
      }
      compiledPath = outFile;
    } else if (language === 'c') {
      const codeFile = path.join(tmpDir, 'solution.c');
      const outFile = path.join(tmpDir, 'solutionc');
      fs.writeFileSync(codeFile, code);
      const compileResult = await runProcessAsync('gcc', ['-o', outFile, codeFile], null, 30000);
      if (compileResult.code !== 0) {
        removeTmpDir(tmpDir);
        return { error: compileResult.stderr || 'Compilation Error' };
      }
      compiledPath = outFile;
    }

    let runResult;
    if (language === 'python') {
      const codeFile = path.join(tmpDir, 'solution.py');
      fs.writeFileSync(codeFile, code);
      runResult = await runProcessAsync('python3', [codeFile], input || '', 10000);
    } else if (language === 'cpp' || language === 'c') {
      runResult = await runProcessAsync(compiledPath, [], input || '', 10000);
    } else if (language === 'javascript') {
      const codeFile = path.join(tmpDir, 'solution.js');
      fs.writeFileSync(codeFile, code);
      runResult = await runProcessAsync('node', [codeFile], input || '', 10000);
    }

    removeTmpDir(tmpDir);
    if (runResult.timedOut) return { error: 'Time Limit Exceeded' };
    if (runResult.code !== 0) return { error: runResult.stderr || 'Runtime Error' };
    return { output: runResult.stdout || '(no output)' };
  } catch (e) {
    removeTmpDir(tmpDir);
    return { error: e.message || 'Error' };
  }
}

function parseTestcases(inputRaw, outputRaw) {
  let inputs = Array.isArray(inputRaw) ? inputRaw : (inputRaw ? [inputRaw] : []);
  let outputs = Array.isArray(outputRaw) ? outputRaw : (outputRaw ? [outputRaw] : []);
  return inputs.map((inp, i) => ({ input: inp || '', output: outputs[i] || '' })).filter(tc => tc.input && tc.output);
}

// ─── ROUTES ───────────────────────────────────────────────

app.get('/', async (req, res) => {
  const allContests = await getContests().find().sort({ _id: -1 }).limit(3).toArray();
  const recentContests = allContests.map(c => ({ ...c, id: c._id.toString() }));

  const topUsers = await getSolves().aggregate([
    { $group: { _id: '$username', solved: { $sum: 1 } } },
    { $sort: { solved: -1 } },
    { $limit: 5 },
    { $project: { _id: 0, username: '$_id', solved: 1 } }
  ]).toArray();

  res.render('index', { user: req.session.user || null, recentContests, topUsers });
});

app.get('/login', (req, res) => res.render('login', {}));
app.get('/register', (req, res) => res.render('register', {}));

app.post('/register', async (req, res) => {
  const { username, password, confirmPassword, email } = req.body;
  if (username.length < 3 || username.length > 20) return res.render('register', { error: 'Username must be between 3 and 20 characters.' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.render('register', { error: 'Username can only contain letters, numbers, and underscores.' });
  if (await getUsers().findOne({ username })) return res.render('register', { error: 'Username already exists.' });
  if (password.length < 6) return res.render('register', { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword) return res.render('register', { error: 'Passwords do not match.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.render('register', { error: 'Invalid email address.' });
  if (await getUsers().findOne({ email })) return res.render('register', { error: 'Email already in use.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.pendingUser = { username, password: hashedPassword, email };
  req.session.verifyCode = verifyCode;
  try {
    await sendEmail(email, 'DOJ - Xác nhận email của bạn', emailTemplate(`
      <h2 style="margin:0 0 10px; font-size:20px; font-weight:700; color:#0f0f23;">Xác nhận email của bạn</h2>
      <p style="margin:0 0 24px; color:#555; font-size:14px; line-height:1.7;">Chào mừng bạn đến với <strong>Dary Online Judge</strong>! Vui lòng nhập mã xác nhận bên dưới để hoàn tất đăng ký tài khoản.</p>
      <div style="text-align:center; padding:16px 0 20px;">
        <div style="color:#888; font-size:11px; letter-spacing:3px; text-transform:uppercase; margin-bottom:14px;">Mã xác nhận của bạn</div>
        <div style="font-size:32px; font-weight:800; letter-spacing:10px; color:#00e5a0; font-family:'Courier New',monospace; text-indent:10px;">${verifyCode}</div>
        <div style="width:60px; height:3px; background:#00e5a0; margin:12px auto; border-radius:2px;"></div>
        <div style="color:#aaa; font-size:12px;">Mã có hiệu lực trong <strong style="color:#555;">10 phút</strong></div>
      </div>
    `));
  } catch (e) { console.error('Email error:', e.message); }
  res.redirect('/verify');
});

app.get('/verify', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/register');
  res.render('verify', { error: undefined });
});

app.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (code === req.session.verifyCode) {
    const userData = req.session.pendingUser;
    const adminEmails = ['cabien0789@gmail.com', 'tuannreal01@gmail.com'];
    if (adminEmails.includes(userData.email)) userData.role = 'admin';
    await getUsers().insertOne(userData);
    req.session.pendingUser = null;
    req.session.verifyCode = null;
    res.render('register-success');
  } else {
    res.render('verify', { error: 'Invalid verification code. Please try again.' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await getUsers().findOne({ username });
  if (!user) return res.render('login', { error: 'Username does not exist.' });
  if (user.locked) return res.render('login', { error: 'This account has been locked. Please contact admin.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.render('login', { error: 'Incorrect password.' });
  req.session.user = { username: user.username, email: user.email, role: user.role || 'user' };
  res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.get('/forgot-password', (req, res) => res.render('forgot-password', { error: undefined, success: undefined }));

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await getUsers().findOne({ email });
  if (!user) return res.render('forgot-password', { error: 'No account found with that email.', success: undefined });
  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.resetEmail = email;
  req.session.resetCode = resetCode;
  try {
    await sendEmail(email, 'DOJ - Đặt lại mật khẩu', emailTemplate(`
      <h2 style="margin:0 0 10px; font-size:20px; font-weight:700; color:#0f0f23;">Đặt lại mật khẩu</h2>
      <p style="margin:0 0 24px; color:#555; font-size:14px; line-height:1.7;">Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản <strong>Dary Online Judge</strong> của bạn.</p>
      <div style="text-align:center; padding:16px 0 20px;">
        <div style="color:#888; font-size:11px; letter-spacing:3px; text-transform:uppercase; margin-bottom:14px;">Mã đặt lại mật khẩu</div>
        <div style="font-size:32px; font-weight:800; letter-spacing:10px; color:#00e5a0; font-family:'Courier New',monospace; text-indent:10px;">${resetCode}</div>
        <div style="width:60px; height:3px; background:#00e5a0; margin:12px auto; border-radius:2px;"></div>
        <div style="color:#aaa; font-size:12px;">Mã có hiệu lực trong <strong style="color:#555;">10 phút</strong></div>
      </div>
    `));
  } catch (e) { console.error('Email error:', e.message); }
  res.redirect('/reset-password');
});

app.get('/reset-password', (req, res) => {
  if (!req.session.resetEmail) return res.redirect('/forgot-password');
  res.render('reset-password', { error: undefined });
});

app.post('/reset-password', async (req, res) => {
  const { code, password, confirmPassword } = req.body;
  if (code !== req.session.resetCode) return res.render('reset-password', { error: 'Invalid reset code.' });
  if (password.length < 6) return res.render('reset-password', { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword) return res.render('reset-password', { error: 'Passwords do not match.' });
  const hashedPassword = await bcrypt.hash(password, 10);
  await getUsers().updateOne({ email: req.session.resetEmail }, { $set: { password: hashedPassword } });
  req.session.resetEmail = null;
  req.session.resetCode = null;
  res.redirect('/login');
});

app.get('/change-password', requireLogin, (req, res) => res.render('change-password', { user: req.session.user, error: undefined, success: undefined }));

app.post('/change-password', requireLogin, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await getUsers().findOne({ username: req.session.user.username });
  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) return res.render('change-password', { user: req.session.user, error: 'Current password is incorrect.', success: undefined });
  if (newPassword.length < 6) return res.render('change-password', { user: req.session.user, error: 'New password must be at least 6 characters.', success: undefined });
  if (newPassword !== confirmPassword) return res.render('change-password', { user: req.session.user, error: 'Passwords do not match.', success: undefined });
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await getUsers().updateOne({ username: req.session.user.username }, { $set: { password: hashedPassword } });
  res.render('change-password', { user: req.session.user, error: undefined, success: 'Password changed successfully!' });
});

// ─── NOTIFICATIONS ────────────────────────────────────────

app.get('/notifications', requireLogin, async (req, res) => {
  const notifications = await getNotifications().find({ username: req.session.user.username }).sort({ createdAt: -1 }).toArray();
  await getNotifications().updateMany({ username: req.session.user.username, read: false }, { $set: { read: true } });
  res.render('notifications', { user: req.session.user, notifications });
});

app.get('/notifications/count', requireLogin, async (req, res) => {
  const count = await getNotifications().countDocuments({ username: req.session.user.username, read: false });
  res.json({ count });
});

// ─── RUN CODE ─────────────────────────────────────────────

app.post('/run', requireLogin, async (req, res) => {
  const { code, language, input } = req.body;
  res.json(await runCodeOnce(code, language, input));
});

// ─── API MY PROBLEMS ──────────────────────────────────────

app.get('/api/my-problems', requireLogin, async (req, res) => {
  const q = req.query.q || '';
  const query = { author: req.session.user.username, deletedFromProfile: { $ne: true } };
  if (q) query.title = { $regex: q, $options: 'i' };
  const problems = await getProblems().find(query).toArray();
  res.json(problems.map(p => ({ id: p._id.toString(), title: p.title, difficulty: p.difficulty })));
});

// ─── LEADERBOARD ──────────────────────────────────────────

app.get('/leaderboard', async (req, res) => {
  const leaderboard = await getSolves().aggregate([
    { $group: { _id: '$username', solved: { $sum: 1 }, lastSolvedAt: { $max: '$solvedAt' } } },
    { $sort: { solved: -1, lastSolvedAt: 1 } },
    { $project: { _id: 0, username: '$_id', solved: 1, lastSolvedAt: 1 } }
  ]).toArray();
  res.render('leaderboard', { user: req.session.user || null, leaderboard });
});

// ─── PROBLEMS ─────────────────────────────────────────────

app.get('/problems', async (req, res) => {
  const user = req.session.user || null;
  const featuredProblems = await getProblems().find({ featured: true }, { projection: { title: 1, difficulty: 1, tags: 1, author: 1 } }).toArray();

  const solvedSet = new Set();
  if (user) {
    const userSolves = await getSolves().find({ username: user.username }, { projection: { problemId: 1 } }).toArray();
    userSolves.forEach(s => solvedSet.add(s.problemId));
  }

  const problems = featuredProblems.map(p => {
    const pid = p._id.toString();
    return { ...p, id: pid, solved: solvedSet.has(pid), orgName: p.author, orgId: null };
  });
  res.render('problems', { user, problems });
});



app.get('/problems/:id', async (req, res) => {
  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  problem.id = problem._id.toString();
  const user = req.session.user || null;
  const mySubmissions = user ? await getSubmissions().find(
    { username: user.username, problemId: problem.id, status: { $ne: 'pending' } },
    { projection: { result: 0, status: 0 } }
  ).sort({ submittedAt: -1 }).limit(5).toArray() : [];
  const contestId = req.query.contestId || null;
  res.render('problem-detail', { user, problem, mySubmissions, contestId });
});

app.post('/problems/:id/submit', requireLogin, async (req, res) => {
  const { code, language } = req.body;
  const role = req.session.user.role;

  if (role !== 'admin' && role !== 'org') {
    if (!checkSubmitRateLimit(req.session.user.username)) {
      return res.json({ error: 'You are submitting too fast. Please wait a moment before trying again.' });
    }
  }

  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.json({ error: 'Problem not found.' }); }
  if (!problem) return res.json({ error: 'Problem not found.' });
  problem.id = problem._id.toString();

  const inserted = await getSubmissions().insertOne({
    username: req.session.user.username,
    problemId: problem.id,
    problemTitle: problem.title,
    language,
    status: 'pending',
    submittedAt: new Date().toISOString()
  });

  const task = {
    submissionId: inserted.insertedId.toString(),
    code, language,
    testcases: [...(problem.sampleTestcases || []), ...(problem.hiddenTestcases || [])],
    timeLimit: problem.timeLimit,
    username: req.session.user.username,
    problemId: problem.id,
    problemTitle: problem.title
  };

  submitToJudge(task);
  res.json({ submissionId: task.submissionId });
});

app.get('/submissions/:id/status', requireLogin, async (req, res) => {
  let sub;
  try { sub = await getSubmissions().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.json({ status: 'error' }); }
  if (!sub || sub.username !== req.session.user.username) return res.json({ status: 'error' });
  if (sub.status === 'pending') return res.json({ status: 'pending' });
  const result = sub.result;
  await getSubmissions().updateOne({ _id: new ObjectId(req.params.id) }, { $unset: { result: '', status: '' } });
  res.json({ status: 'done', result, problemId: sub.problemId, language: sub.language });
});

app.get('/submission-result', requireLogin, (req, res) => {
  res.render('submission-result', {});
});

app.get('/problems/:id/edit', requireLogin, async (req, res) => {
  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  if (problem.author !== req.session.user.username) return res.redirect('/problems/' + req.params.id);
  problem.id = problem._id.toString();
  const contestId = req.query.contestId || null;
  res.render('edit-problem', { user: req.session.user, problem, error: undefined, contestId });
});

app.post('/problems/:id/edit', requireLogin, async (req, res) => {
  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  if (problem.author !== req.session.user.username) return res.redirect('/problems/' + req.params.id);
  const { title, difficulty, statement, inputFormat, outputFormat, timeLimit, constraints, explanation } = req.body;
  const sampleTestcases = parseTestcases(req.body['sampleInput[]'] || req.body.sampleInput, req.body['sampleOutput[]'] || req.body.sampleOutput);
  const hiddenTestcases = parseTestcases(req.body['hiddenInput[]'] || req.body.hiddenInput, req.body['hiddenOutput[]'] || req.body.hiddenOutput);
  let tags = req.body['tags[]'] || req.body.tags || [];
  if (!Array.isArray(tags)) tags = [tags];
  const contestId = req.body.contestId || null;
  const redirectUrl = '/problems/' + req.params.id + (contestId ? '?contestId=' + contestId : '');
  const allFields = [title, difficulty, statement, inputFormat, outputFormat, constraints, explanation, ...tags,
    ...sampleTestcases.map(tc => tc.input + tc.output),
    ...hiddenTestcases.map(tc => tc.input + tc.output)
  ].join('');
  const sizeBytes = Buffer.byteLength(allFields, 'utf8');
  const role = req.session.user.role;
  if (role === 'org') {
    if (sizeBytes > 0.4 * 1024 * 1024) return res.render('edit-problem', { user: req.session.user, problem, error: 'Problem size exceeds the 0.4MB limit.', contestId });
  }
  if (role === 'admin') {
    if (sizeBytes > 0.85 * 1024 * 1024) return res.render('edit-problem', { user: req.session.user, problem, error: 'Problem size exceeds the 0.85MB limit.', contestId });
  }
  try {
    await getProblems().updateOne({ _id: new ObjectId(req.params.id) }, { $set: {
      title, difficulty, statement, inputFormat, outputFormat,
      constraints: constraints || '', explanation: explanation || '',
      sampleTestcases, hiddenTestcases,
      tags, timeLimit: parseInt(timeLimit) || 2
    }});
  } catch (e) { return res.redirect('/problems'); }
  res.redirect(redirectUrl);
});

app.post('/problems/:id/delete', requireLogin, async (req, res) => {
  try {
    const problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
    if (!problem || problem.author !== req.session.user.username) return res.redirect('/problems');
    await deleteProblemAndRelated(problem._id);
  } catch (e) {}
  res.redirect('/problems');
});

app.post('/problems/:id/remove-from-profile', requireLogin, async (req, res) => {
  try {
    const problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
    if (!problem || problem.author !== req.session.user.username) return res.status(403).json({ error: 'Forbidden' });
    await deleteProblemAndRelated(problem._id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ─── PROFILE ──────────────────────────────────────────────

app.get('/profile/:username', async (req, res) => {
  const targetUser = await getUsers().findOne({ username: req.params.username });
  if (!targetUser) return res.redirect('/');
  const solved = await getSolves().countDocuments({ username: req.params.username });
  const myProblems = await getProblems().find({
    author: req.params.username,
    deletedFromProfile: { $ne: true }
  }).toArray();
  const myProblemsWithId = myProblems.map(p => ({ ...p, id: p._id.toString() }));
  res.render('profile', {
    user: req.session.user || null,
    targetUser: { username: targetUser.username, email: targetUser.email, createdAt: (() => { try { return targetUser._id.getTimestamp().toISOString(); } catch(e) { return null; } })() },
    solved, myProblems: myProblemsWithId
  });
});

// ─── ORGANIZATIONS ────────────────────────────────────────

app.get('/organizations', async (req, res) => {
  const organizations = await getOrgs().find().toArray();
  const orgsWithId = organizations.map(o => ({ ...o, id: o._id.toString() }));
  res.render('organizations', { user: req.session.user || null, organizations: orgsWithId });
});

app.get('/organizations/create', requireOrg, (req, res) => res.render('create-organization', { user: req.session.user, error: undefined }));

app.post('/organizations/create', requireOrg, async (req, res) => {
  const { name, description, hidden } = req.body;
  if (req.session.user.role === 'org') {
    const orgCount = await getOrgs().countDocuments({ owner: req.session.user.username });
    if (orgCount >= 15) return res.render('create-organization', { user: req.session.user, error: 'You have reached the maximum limit of 15 organizations.' });
  }
  if (!name || name.trim().length < 3) return res.render('create-organization', { user: req.session.user, error: 'Organization name must be at least 3 characters.' });
  if (await getOrgs().findOne({ name: name.trim() })) return res.render('create-organization', { user: req.session.user, error: 'Organization name already exists.' });
  const result = await getOrgs().insertOne({
    name: name.trim(), description: description || '',
    owner: req.session.user.username, members: [req.session.user.username], pendingMembers: [],
    hidden: hidden === 'true'
  });
  res.redirect('/organizations/' + result.insertedId.toString());
});

app.get('/organizations/:id/edit', requireLogin, async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!org) return res.redirect('/organizations');
  if (org.owner !== req.session.user.username) return res.redirect('/organizations/' + req.params.id);
  org.id = org._id.toString();
  res.render('edit-organization', { user: req.session.user, org, error: undefined });
});

app.post('/organizations/:id/edit', requireLogin, async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!org) return res.redirect('/organizations');
  if (org.owner !== req.session.user.username) return res.redirect('/organizations/' + req.params.id);
  org.id = org._id.toString();
  const { name, description, hidden } = req.body;
  if (!name || name.trim().length < 3) {
    return res.render('edit-organization', { user: req.session.user, org, error: 'Organization name must be at least 3 characters.' });
  }
  const duplicate = await getOrgs().findOne({ name: name.trim(), _id: { $ne: new ObjectId(req.params.id) } });
  if (duplicate) {
    return res.render('edit-organization', { user: req.session.user, org, error: 'Organization name already exists.' });
  }
  await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { name: name.trim(), description: description || '', hidden: hidden === 'true' } });
  res.redirect('/organizations/' + req.params.id);
});

app.get('/organizations/:id', async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!org) return res.redirect('/organizations');
  org.id = org._id.toString();
  const user = req.session.user || null;
  const isMember = user && org.members && org.members.includes(user.username);
  const isAdmin = user && user.role === 'admin';
  if (org.hidden === true && !isMember && !isAdmin) {
    return res.render('organization-detail', { user, org, contests: [], accessDenied: true });
  }
  const allContests = await getContests().find({ orgId: org.id }).toArray();
  const contests = allContests.map(c => ({ ...c, id: c._id.toString() })).sort((a, b) => {
    const aPinned = a.pinnedAt ? 1 : 0;
    const bPinned = b.pinnedAt ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    if (a.pinnedAt && b.pinnedAt) return new Date(b.pinnedAt) - new Date(a.pinnedAt);
    return a._id.toString() < b._id.toString() ? -1 : 1;
  });
  res.render('organization-detail', { user, org, contests, accessDenied: false });
});

app.post('/organizations/:id/request', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (!org) return res.redirect('/organizations');
    if (org.members && org.members.includes(req.session.user.username)) return res.redirect('/organizations/' + req.params.id);
    await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $addToSet: { pendingMembers: req.session.user.username } });
    await sendNotification(org.owner, `${req.session.user.username} has requested to join your organization "${org.name}".`);
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.post('/organizations/:id/cancel-request', requireLogin, async (req, res) => {
  try { await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { pendingMembers: req.session.user.username } }); } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.post('/organizations/:id/approve/:username', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/organizations/' + req.params.id);
    await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { pendingMembers: req.params.username }, $addToSet: { members: req.params.username } });
    await sendNotification(req.params.username, `Your request to join "${org.name}" has been approved!`);
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.post('/organizations/:id/reject/:username', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/organizations/' + req.params.id);
    await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { pendingMembers: req.params.username } });
    await sendNotification(req.params.username, `Your request to join "${org.name}" has been rejected.`);
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.post('/organizations/:id/kick/:username', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/organizations/' + req.params.id);
    await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { members: req.params.username } });
    await sendNotification(req.params.username, `You have been removed from the organization "${org.name}".`);
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.post('/organizations/:id/leave', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (org && org.owner !== req.session.user.username)
      await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { members: req.session.user.username } });
  } catch (e) {}
  res.redirect('/organizations');
});

app.post('/organizations/:id/delete', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations/' + req.params.id);
    await getOrgs().deleteOne({ _id: new ObjectId(req.params.id) });
  } catch (e) {}
  res.redirect('/organizations');
});

app.post('/contests/:id/pin', requireLogin, async (req, res) => {
  try {
    const contest = await getContests().findOne({ _id: new ObjectId(req.params.id) });
    if (!contest) return res.redirect('/organizations');
    const org = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
    if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);
    await getContests().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { pinnedAt: new Date().toISOString() } });
    res.redirect('/organizations/' + contest.orgId);
  } catch (e) { res.redirect('/organizations'); }
});

app.post('/contests/:id/unpin', requireLogin, async (req, res) => {
  try {
    const contest = await getContests().findOne({ _id: new ObjectId(req.params.id) });
    if (!contest) return res.redirect('/organizations');
    const org = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
    if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);
    await getContests().updateOne({ _id: new ObjectId(req.params.id) }, { $unset: { pinnedAt: '' } });
    res.redirect('/organizations/' + contest.orgId);
  } catch (e) { res.redirect('/organizations'); }
});

// ─── CONTESTS ─────────────────────────────────────────────

app.get('/organizations/:id/contests/create', requireLogin, async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/organizations');
  org.id = org._id.toString();
  res.render('create-contest', { user: req.session.user, orgId: org.id, error: undefined, serverTime: getServerTime() });
});

app.post('/organizations/:id/contests/create', requireLogin, async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!org || (org.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/organizations');
  const { name, timezone, noTimeLimit, visibility } = req.body;
  let problemIds = req.body['problemIds[]'] || req.body.problemIds || [];
  if (!Array.isArray(problemIds)) problemIds = [problemIds];
  const isNoLimit = noTimeLimit === 'on';
  const startTimeUTC = isNoLimit ? null : toUTC(req.body.startTime, timezone);
  const endTimeUTC = isNoLimit ? null : toUTC(req.body.endTime, timezone);
  if (!isNoLimit) {
    const validationError = validateContestTime(startTimeUTC, endTimeUTC);
    if (validationError) return res.render('create-contest', { user: req.session.user, orgId: org._id.toString(), error: validationError, serverTime: getServerTime() });
  }
  await getContests().insertOne({
    name, orgId: org._id.toString(), timezone: timezone || 'UTC',
    noTimeLimit: isNoLimit, visibility: visibility || 'public',
    startTime: req.body.startTime ? req.body.startTime.slice(0, 16) : null,
    endTime: req.body.endTime ? req.body.endTime.slice(0, 16) : null,
    startTimeUTC, endTimeUTC, problemIds
  });
  res.redirect('/organizations/' + org._id.toString());
});

app.get('/contests/:id/edit', requireLogin, async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');
  const matchOrg = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
  if (!matchOrg || (matchOrg.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);
  contest.id = contest._id.toString();
  const myProblems = await getProblems().find({ author: req.session.user.username, deletedFromProfile: { $ne: true } }).toArray();
  const myProblemsWithId = myProblems.map(p => ({ ...p, id: p._id.toString() }));
  const problems = [
    ...contest.problemIds.map(pid => myProblemsWithId.find(p => p.id === pid)).filter(p => p),
    ...myProblemsWithId.filter(p => !contest.problemIds.includes(p.id))
  ];
  res.render('edit-contest', { user: req.session.user, contest, problems, error: undefined, serverTime: getServerTime() });
});

app.post('/contests/:id/edit', requireLogin, async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');
  const matchOrg = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
  if (!matchOrg || (matchOrg.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);
  const { name, timezone, noTimeLimit, visibility } = req.body;
  let problemIds = req.body['problemIds[]'] || req.body.problemIds || [];
  if (!Array.isArray(problemIds)) problemIds = [problemIds];
  const isNoLimit = noTimeLimit === 'on';
  const startTimeUTC = isNoLimit ? null : toUTC(req.body.startTime, timezone);
  const endTimeUTC = isNoLimit ? null : toUTC(req.body.endTime, timezone);
  if (!isNoLimit) {
    const validationError = validateContestTime(startTimeUTC, endTimeUTC);
    if (validationError) {
      contest.id = contest._id.toString();
      contest.startTime = req.body.startTime ? req.body.startTime.slice(0, 16) : contest.startTime;
      contest.endTime = req.body.endTime ? req.body.endTime.slice(0, 16) : contest.endTime;
      contest.timezone = timezone || contest.timezone;
      contest.name = name || contest.name;
      contest.visibility = visibility || contest.visibility;
      contest.noTimeLimit = isNoLimit;
      const myProblems2 = await getProblems().find({ author: req.session.user.username, deletedFromProfile: { $ne: true } }).toArray();
      const myProblemsWithId2 = myProblems2.map(p => ({ ...p, id: p._id.toString() }));
      const problems2 = [
        ...contest.problemIds.map(pid => myProblemsWithId2.find(p => p.id === pid)).filter(p => p),
        ...myProblemsWithId2.filter(p => !contest.problemIds.includes(p.id))
      ];
      return res.render('edit-contest', { user: req.session.user, contest, problems: problems2, error: validationError, serverTime: getServerTime() });
    }
  }
  await getContests().updateOne({ _id: new ObjectId(req.params.id) }, { $set: {
    name, timezone: timezone || 'UTC', noTimeLimit: isNoLimit,
    visibility: visibility || 'public',
    startTime: req.body.startTime ? req.body.startTime.slice(0, 16) : null,
    endTime: req.body.endTime ? req.body.endTime.slice(0, 16) : null,
    startTimeUTC, endTimeUTC, problemIds
  }});
  res.redirect('/contests/' + req.params.id);
});

app.get('/contests/:id/problems/create', requireLogin, async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');
  const matchOrg = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
  if (!matchOrg || (matchOrg.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);
  contest.id = contest._id.toString();
  res.render('create-problem-contest', { user: req.session.user, contestId: contest.id, contestName: contest.name, error: undefined });
});

app.post('/contests/:id/problems/create', requireLogin, async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');
  const matchOrg = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
  if (!matchOrg || (matchOrg.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);

  const { title, difficulty, statement, inputFormat, outputFormat, timeLimit, constraints, explanation } = req.body;
  const sampleTestcases = parseTestcases(req.body['sampleInput[]'] || req.body.sampleInput, req.body['sampleOutput[]'] || req.body.sampleOutput);
  const hiddenTestcases = parseTestcases(req.body['hiddenInput[]'] || req.body.hiddenInput, req.body['hiddenOutput[]'] || req.body.hiddenOutput);
  let tags = req.body['tags[]'] || req.body.tags || [];
  if (!Array.isArray(tags)) tags = [tags];

  const role = req.session.user.role;
  const contestId = contest._id.toString();
  const contestName = contest.name;

  const allFields = [title, difficulty, statement, inputFormat, outputFormat, constraints, explanation, ...tags,
    ...sampleTestcases.map(tc => tc.input + tc.output),
    ...hiddenTestcases.map(tc => tc.input + tc.output)
  ].join('');
  const sizeBytes = Buffer.byteLength(allFields, 'utf8');

  if (role === 'org') {
    const problemCount = await getProblems().countDocuments({ author: req.session.user.username });
    if (problemCount >= 120) return res.render('create-problem-contest', { user: req.session.user, contestId, contestName, error: 'You have reached the maximum limit of 120 problems.' });
    if (sizeBytes > 0.4 * 1024 * 1024) return res.render('create-problem-contest', { user: req.session.user, contestId, contestName, error: 'Problem size exceeds the 0.4MB limit.' });
  }
  if (role === 'admin') {
    if (sizeBytes > 0.85 * 1024 * 1024) return res.render('create-problem-contest', { user: req.session.user, contestId, contestName, error: 'Problem size exceeds the 0.85MB limit.' });
  }

  const inserted = await getProblems().insertOne({
    title, difficulty, statement, inputFormat, outputFormat,
    constraints: constraints || '', explanation: explanation || '',
    sampleTestcases, hiddenTestcases,
    tags, timeLimit: parseInt(timeLimit) || 2,
    author: req.session.user.username, createdAt: new Date().toISOString(),
    featured: false, deletedFromProfile: false
  });

  await getContests().updateOne(
    { _id: new ObjectId(req.params.id) },
    { $addToSet: { problemIds: inserted.insertedId.toString() } }
  );

  res.redirect('/contests/' + req.params.id);
});

app.post('/contests/:id/delete', requireLogin, async (req, res) => {
  try {
    const contest = await getContests().findOne({ _id: new ObjectId(req.params.id) });
    if (!contest) return res.redirect('/organizations');
    const matchOrg = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
    if (!matchOrg || (matchOrg.owner !== req.session.user.username && req.session.user.role !== 'admin')) return res.redirect('/contests/' + req.params.id);
    await getContests().deleteOne({ _id: new ObjectId(req.params.id) });
    res.redirect('/organizations/' + contest.orgId);
  } catch (e) { res.redirect('/organizations'); }
});

app.get('/contests/:id', async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); } catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');
  contest.id = contest._id.toString();

  const matchOrg = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
  const isOwner = req.session.user && matchOrg && (matchOrg.owner === req.session.user.username || req.session.user.role === 'admin');
  const isMember = req.session.user && matchOrg && matchOrg.members && matchOrg.members.includes(req.session.user.username);
  const isAdmin = req.session.user && req.session.user.role === 'admin';

  if (contest.visibility === 'private' && !isMember && !isAdmin) {
    return res.render('contest-detail', {
      user: req.session.user || null, contest, problems: [], scoreboard: [], isOwner: false, accessDenied: true, solvedSet: [], orgId: contest.orgId
    });
  }

  const contestProblemObjectIds = contest.problemIds.map(pid => { try { return new ObjectId(pid); } catch(e) { return null; } }).filter(Boolean);
  const problemDocs = await getProblems().find({ _id: { $in: contestProblemObjectIds } }, { projection: { title: 1, difficulty: 1 } }).toArray();
  const problems = contest.problemIds.map(pid => {
    const p = problemDocs.find(p => p._id.toString() === pid);
    return p ? { ...p, id: p._id.toString() } : null;
  }).filter(p => p !== null);

  const startUTC = contest.startTimeUTC || contest.startTime;
  const endUTC = contest.endTimeUTC || contest.endTime;

  let allSolves;
  if (contest.noTimeLimit) {
    allSolves = await getSolves().find({ problemId: { $in: contest.problemIds } }).toArray();
  } else {
    allSolves = await getSolves().find({ problemId: { $in: contest.problemIds }, solvedAt: { $gte: startUTC, $lte: endUTC } }).toArray();
  }

  const scoreMap = {};
  allSolves.forEach(s => {
    if (!scoreMap[s.username]) scoreMap[s.username] = { solved: 0, lastAC: null };
    scoreMap[s.username].solved++;
    if (!scoreMap[s.username].lastAC || s.solvedAt > scoreMap[s.username].lastAC) scoreMap[s.username].lastAC = s.solvedAt;
  });

  const scoreboard = Object.entries(scoreMap)
    .map(([username, data]) => ({ username, solved: data.solved, lastAC: data.lastAC }))
    .sort((a, b) => b.solved - a.solved || new Date(a.lastAC) - new Date(b.lastAC));

  const userSolvedInContest = new Set();
  if (req.session.user) {
    const userSolves = contest.noTimeLimit
      ? await getSolves().find({ username: req.session.user.username, problemId: { $in: contest.problemIds } }).toArray()
      : await getSolves().find({ username: req.session.user.username, problemId: { $in: contest.problemIds }, solvedAt: { $gte: startUTC, $lte: endUTC } }).toArray();
    userSolves.forEach(s => userSolvedInContest.add(s.problemId));
  }

  res.render('contest-detail', {
    user: req.session.user || null,
    contest: { ...contest, startTimeUTC: startUTC, endTimeUTC: endUTC },
    problems, scoreboard, isOwner, accessDenied: false,
    userSolvedInContest: [...userSolvedInContest],
    orgId: contest.orgId
  });
});

// ─── ADMIN ────────────────────────────────────────────────

app.get('/admin', requireAdmin, async (req, res) => {
  const users = await getUsers().find().toArray();
  const orgs = (await getOrgs().find().toArray()).map(o => ({ ...o, id: o._id.toString() }));
  const allProblems = await getProblems().find({}, { projection: { title: 1, difficulty: 1, author: 1, featured: 1 } }).toArray();
  const problems = allProblems.map(p => ({ ...p, id: p._id.toString() }));
  const allContests = await getContests().find({}, { projection: { orgId: 1, name: 1 } }).toArray();
  const contests = allContests.map(c => {
    const org = orgs.find(o => o.id === c.orgId);
    return { ...c, id: c._id.toString(), orgOwner: org ? org.owner : '—' };
  });
  res.render('admin', { user: req.session.user, users, orgs, problems, contests });
});

app.post('/admin/users/:username/lock', requireAdmin, async (req, res) => {
  await getUsers().updateOne({ username: req.params.username }, { $set: { locked: true } });
  await sendNotification(req.params.username, 'Your account has been locked by an administrator. Please contact support.');
  res.redirect('/admin');
});

app.post('/admin/users/:username/unlock', requireAdmin, async (req, res) => {
  await getUsers().updateOne({ username: req.params.username }, { $set: { locked: false } });
  await sendNotification(req.params.username, 'Your account has been unlocked by an administrator.');
  res.redirect('/admin');
});

app.post('/admin/users/:username/grant-org', requireAdmin, async (req, res) => {
  await getUsers().updateOne({ username: req.params.username }, { $set: { role: 'org' } });
  await sendNotification(req.params.username, 'You have been granted Organization role. You can now create organizations.');
  res.redirect('/admin');
});

app.post('/admin/users/:username/revoke-org', requireAdmin, async (req, res) => {
  await getUsers().updateOne({ username: req.params.username }, { $set: { role: 'user' } });
  await sendNotification(req.params.username, 'Your Organization role has been revoked.');
  res.redirect('/admin');
});

app.post('/admin/orgs/:id/delete', requireAdmin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (org) {
      await getOrgs().deleteOne({ _id: new ObjectId(req.params.id) });
      await sendNotification(org.owner, `Your organization "${org.name}" has been deleted by an administrator.`);
    }
  } catch (e) {}
  res.redirect('/admin');
});

app.post('/admin/contests/:id/delete', requireAdmin, async (req, res) => {
  try {
    const contest = await getContests().findOne({ _id: new ObjectId(req.params.id) });
    if (contest) {
      const org = await getOrgs().findOne({ _id: new ObjectId(contest.orgId) });
      await getContests().deleteOne({ _id: new ObjectId(req.params.id) });
      if (org) await sendNotification(org.owner, `Your contest "${contest.name}" has been deleted by an administrator.`);
    }
  } catch (e) {}
  res.redirect('/admin');
});

app.post('/admin/problems/:id/feature', requireAdmin, async (req, res) => {
  try { await getProblems().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { featured: true } }); } catch (e) {}
  res.redirect('/admin');
});

app.post('/admin/problems/:id/unfeature', requireAdmin, async (req, res) => {
  try { await getProblems().updateOne({ _id: new ObjectId(req.params.id) }, { $set: { featured: false } }); } catch (e) {}
  res.redirect('/admin');
});

app.post('/admin/problems/:id/delete', requireAdmin, async (req, res) => {
  try {
    const problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
    if (problem) {
      await sendNotification(problem.author, `Your problem "${problem.title}" has been deleted by an administrator.`);
      await deleteProblemAndRelated(problem._id);
    }
  } catch (e) {}
  res.redirect('/admin');
});

// ─── 404 ──────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).render('404', { user: req.session.user || null });
});

// ─── START ────────────────────────────────────────────────

connectDB().then(() => {
  app.listen(3000, () => console.log('DOJ server running on port 3000'));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});