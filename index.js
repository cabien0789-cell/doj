const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'doj-secret-key',
  resave: false,
  saveUninitialized: false
}));

const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
  await client.connect();
  db = client.db('doj');
  console.log('Connected to MongoDB');
}

function getUsers() { return db.collection('users'); }
function getProblems() { return db.collection('problems'); }
function getOrgs() { return db.collection('organizations'); }
function getContests() { return db.collection('contests'); }
function getSubmissions() { return db.collection('submissions'); }
function getNotifications() { return db.collection('notifications'); }

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const user = await getUsers().findOne({ username: req.session.user.username });
  if (!user || user.role !== 'admin') return res.redirect('/');
  next();
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
  await getNotifications().insertOne({
    username, message, read: false, createdAt: new Date().toISOString()
  });
}

function toUTC(datetimeLocal, timezone) {
  if (!datetimeLocal) return null;
  const date = new Date(datetimeLocal);
  if (timezone === 'Vietnam') {
    return new Date(date.getTime() - 7 * 60 * 60000).toISOString();
  }
  return date.toISOString();
}

function judgeCode(code, language, testcases, timeLimit) {
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const timeLimitMs = (timeLimit || 2) * 1000;
  const details = [];
  let passedCount = 0;
  let compiledPath = null;

  try {
    if (language === 'cpp') {
      const codeFile = path.join(tmpDir, 'solution.cpp');
      const outFile = path.join(tmpDir, 'solution');
      fs.writeFileSync(codeFile, code);
      execSync(`g++ -o ${outFile} ${codeFile}`, { timeout: 30000 });
      compiledPath = outFile;
    } else if (language === 'c') {
      const codeFile = path.join(tmpDir, 'solution.c');
      const outFile = path.join(tmpDir, 'solutionc');
      fs.writeFileSync(codeFile, code);
      execSync(`gcc -o ${outFile} ${codeFile}`, { timeout: 30000 });
      compiledPath = outFile;
    } else if (language === 'java') {
      const codeFile = path.join(tmpDir, 'Main.java');
      fs.writeFileSync(codeFile, code);
      execSync(`javac ${codeFile}`, { timeout: 30000, cwd: tmpDir });
    }
  } catch (e) {
    const errMsg = e.stderr ? e.stderr.toString() : (e.message || 'Compilation Error');
    for (let i = 0; i < testcases.length; i++) {
      details.push({ status: 'CE', passed: false, output: errMsg, expected: testcases[i].output.trim() });
    }
    return { verdict: 'Compilation Error', passed: false, passedCount: 0, total: testcases.length, details };
  }

  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    if (!tc.input || !tc.output) {
      details.push({ status: 'WA', passed: false, output: 'No test case data', expected: '' });
      continue;
    }
    const inputFile = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(inputFile, tc.input);
    const startTime = Date.now();
    try {
      let output = '';
      if (language === 'python') {
        const codeFile = path.join(tmpDir, 'solution.py');
        fs.writeFileSync(codeFile, code);
        output = execSync(`python3 ${codeFile} < ${inputFile}`, { timeout: timeLimitMs }).toString().trim();
      } else if (language === 'cpp' || language === 'c') {
        output = execSync(`${compiledPath} < ${inputFile}`, { timeout: timeLimitMs }).toString().trim();
      } else if (language === 'java') {
        output = execSync(`java -cp ${tmpDir} Main < ${inputFile}`, { timeout: timeLimitMs + 5000 }).toString().trim();
      }
      const execTime = Date.now() - startTime;
      const expected = tc.output.trim();
      const passed = output === expected;
      if (passed) passedCount++;
      details.push({ status: passed ? 'AC' : 'WA', passed, output, expected, execTime });
    } catch (e) {
      const execTime = Date.now() - startTime;
      const isTimeout = e.signal === 'SIGTERM' || (e.message && e.message.includes('ETIMEDOUT'));
      if (isTimeout) {
        details.push({ status: 'TLE', passed: false, output: 'Time Limit Exceeded', expected: tc.output.trim(), execTime });
      } else {
        const errMsg = e.stderr ? e.stderr.toString().split('\n')[0] : (e.message || 'Runtime Error');
        details.push({ status: 'RE', passed: false, output: errMsg, expected: tc.output.trim(), execTime });
      }
    }
  }

  const allPassed = passedCount === testcases.length;
  let verdict = 'Accepted';
  if (!allPassed) {
    const firstFail = details.find(d => !d.passed);
    if (firstFail) verdict = firstFail.status === 'TLE' ? 'Time Limit Exceeded'
                           : firstFail.status === 'RE' ? 'Runtime Error' : 'Wrong Answer';
  }
  const maxExecTime = Math.max(...details.map(d => d.execTime || 0));
  return { verdict, passed: allPassed, passedCount, total: testcases.length, details, execTime: maxExecTime };
}

function runCodeOnce(code, language, input) {
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
  const inputFile = path.join(tmpDir, 'run_input.txt');
  fs.writeFileSync(inputFile, input || '');
  try {
    let output = '';
    if (language === 'python') {
      const codeFile = path.join(tmpDir, 'run_solution.py');
      fs.writeFileSync(codeFile, code);
      output = execSync(`python3 ${codeFile} < ${inputFile}`, { timeout: 10000 }).toString();
    } else if (language === 'cpp') {
      const codeFile = path.join(tmpDir, 'run_solution.cpp');
      const outFile = path.join(tmpDir, 'run_solution');
      fs.writeFileSync(codeFile, code);
      execSync(`g++ -o ${outFile} ${codeFile}`, { timeout: 30000 });
      output = execSync(`${outFile} < ${inputFile}`, { timeout: 10000 }).toString();
    } else if (language === 'c') {
      const codeFile = path.join(tmpDir, 'run_solution.c');
      const outFile = path.join(tmpDir, 'run_solutionc');
      fs.writeFileSync(codeFile, code);
      execSync(`gcc -o ${outFile} ${codeFile}`, { timeout: 30000 });
      output = execSync(`${outFile} < ${inputFile}`, { timeout: 10000 }).toString();
    } else if (language === 'java') {
      const codeFile = path.join(tmpDir, 'RunMain.java');
      fs.writeFileSync(codeFile, code.replace('public class Main', 'public class RunMain'));
      execSync(`javac ${codeFile}`, { timeout: 30000, cwd: tmpDir });
      output = execSync(`java -cp ${tmpDir} RunMain < ${inputFile}`, { timeout: 10000 }).toString();
    }
    return { output: output || '(no output)' };
  } catch (e) {
    return { error: e.stderr ? e.stderr.toString() : (e.message || 'Error') };
  }
}

function parseTestcases(inputRaw, outputRaw) {
  let inputs = Array.isArray(inputRaw) ? inputRaw : (inputRaw ? [inputRaw] : []);
  let outputs = Array.isArray(outputRaw) ? outputRaw : (outputRaw ? [outputRaw] : []);
  return inputs.map((inp, i) => ({ input: inp || '', output: outputs[i] || '' }))
               .filter(tc => tc.input && tc.output);
}

// ─── ROUTES ───────────────────────────────────────────────

app.get('/', async (req, res) => {
  const problemCount = await getProblems().countDocuments();
  const userCount = await getUsers().countDocuments();
  const submissionCount = await getSubmissions().countDocuments();
  res.render('index', {
    user: req.session.user || null,
    stats: { problems: problemCount, users: userCount, submissions: submissionCount }
  });
});

app.get('/login', (req, res) => res.render('login', {}));
app.get('/register', (req, res) => res.render('register', {}));

app.post('/register', async (req, res) => {
  const { username, password, confirmPassword, email } = req.body;
  if (username.length < 3 || username.length > 20)
    return res.render('register', { error: 'Username must be between 3 and 20 characters.' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.render('register', { error: 'Username can only contain letters, numbers, and underscores.' });
  if (await getUsers().findOne({ username }))
    return res.render('register', { error: 'Username already exists.' });
  if (password.length < 6)
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword)
    return res.render('register', { error: 'Passwords do not match.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.render('register', { error: 'Invalid email address.' });
  if (await getUsers().findOne({ email }))
    return res.render('register', { error: 'Email already in use.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.pendingUser = { username, password: hashedPassword, email };
  req.session.verifyCode = verifyCode;

  try {
    await sendEmail(email, 'DOJ - Xác nhận email của bạn', emailTemplate(`
      <h2 style="margin:0 0 10px; font-size:20px; font-weight:700; color:#0f0f23;">Xác nhận email của bạn</h2>
      <p style="margin:0 0 24px; color:#555; font-size:14px; line-height:1.7;">
        Chào mừng bạn đến với <strong>Dary Online Judge</strong>! Vui lòng nhập mã xác nhận bên dưới để hoàn tất đăng ký tài khoản.
      </p>
      <div style="text-align:center; padding:16px 0 20px;">
        <div style="color:#888; font-size:11px; letter-spacing:3px; text-transform:uppercase; margin-bottom:14px;">Mã xác nhận của bạn</div>
        <div style="font-size:32px; font-weight:800; letter-spacing:10px; color:#00e5a0; font-family:'Courier New',monospace; text-indent:10px;">${verifyCode}</div>
        <div style="width:60px; height:3px; background:#00e5a0; margin:12px auto; border-radius:2px;"></div>
        <div style="color:#aaa; font-size:12px;">Mã có hiệu lực trong <strong style="color:#555;">10 phút</strong></div>
      </div>
      <p style="margin:0; color:#777; font-size:13px; line-height:1.7;">
        Sau khi xác nhận, bạn có thể bắt đầu luyện tập với hàng trăm bài toán lập trình, tham gia các contest và theo dõi tiến trình của mình trên bảng xếp hạng.
      </p>
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
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.render('login', { error: 'Incorrect password.' });
  req.session.user = { username: user.username, email: user.email, role: user.role || 'user' };
  res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ─── FORGOT / RESET / CHANGE PASSWORD ────────────────────

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

app.get('/change-password', requireLogin, (req, res) => {
  res.render('change-password', { user: req.session.user, error: undefined, success: undefined });
});

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
  const notifications = await getNotifications()
    .find({ username: req.session.user.username })
    .sort({ createdAt: -1 }).toArray();
  await getNotifications().updateMany(
    { username: req.session.user.username, read: false },
    { $set: { read: true } }
  );
  res.render('notifications', { user: req.session.user, notifications });
});

app.get('/notifications/count', requireLogin, async (req, res) => {
  const count = await getNotifications().countDocuments({
    username: req.session.user.username, read: false
  });
  res.json({ count });
});

// ─── RUN CODE ─────────────────────────────────────────────

app.post('/run', requireLogin, (req, res) => {
  const { code, language, input } = req.body;
  res.json(runCodeOnce(code, language, input));
});

// ─── LEADERBOARD ──────────────────────────────────────────

app.get('/leaderboard', async (req, res) => {
  const allSubs = await getSubmissions().find().sort({ submittedAt: 1 }).toArray();
  const userMap = {};
  allSubs.forEach(s => {
    if (!userMap[s.username]) userMap[s.username] = { username: s.username, solved: new Set(), solvedTime: {}, totalSubmissions: 0, accepted: 0 };
    userMap[s.username].totalSubmissions++;
    if (s.verdict === 'Accepted') {
      userMap[s.username].accepted++;
      if (!userMap[s.username].solved.has(s.problemId)) {
        userMap[s.username].solved.add(s.problemId);
        userMap[s.username].solvedTime[s.problemId] = s.submittedAt;
      }
    }
  });
  const leaderboard = Object.values(userMap)
    .map(u => {
      const lastSolvedTime = u.solved.size > 0 ? Object.values(u.solvedTime).sort().slice(-1)[0] : null;
      return { username: u.username, solved: u.solved.size, totalSubmissions: u.totalSubmissions, accepted: u.accepted, lastSolvedTime };
    })
    .sort((a, b) => b.solved !== a.solved ? b.solved - a.solved : new Date(a.lastSolvedTime) - new Date(b.lastSolvedTime));
  res.render('leaderboard', { user: req.session.user || null, leaderboard });
});

// ─── PROBLEMS ─────────────────────────────────────────────

app.get('/problems', async (req, res) => {
  const problems = await getProblems().find().toArray();
  const user = req.session.user || null;
  const allSubs = await getSubmissions().find().toArray();
  const solvedSet = new Set();
  if (user) allSubs.filter(s => s.username === user.username && s.verdict === 'Accepted').forEach(s => solvedSet.add(s.problemId));
  const subsByProblem = {};
  allSubs.forEach(s => {
    if (!subsByProblem[s.problemId]) subsByProblem[s.problemId] = { total: 0, accepted: 0 };
    subsByProblem[s.problemId].total++;
    if (s.verdict === 'Accepted') subsByProblem[s.problemId].accepted++;
  });
  const problemsWithStatus = problems.map(p => ({
    ...p, id: p._id.toString(),
    solved: solvedSet.has(p._id.toString()),
    totalSubmissions: (subsByProblem[p._id.toString()] || {}).total || 0,
    acceptedSubmissions: (subsByProblem[p._id.toString()] || {}).accepted || 0
  }));
  res.render('problems', { user, problems: problemsWithStatus });
});

app.get('/problems/create', requireLogin, (req, res) => {
  res.render('create-problem', { user: req.session.user, error: undefined });
});

app.post('/problems/create', requireLogin, async (req, res) => {
  const { title, difficulty, statement, inputFormat, outputFormat, timeLimit, constraints, explanation } = req.body;
  const sampleTestcases = parseTestcases(req.body['sampleInput[]'] || req.body.sampleInput, req.body['sampleOutput[]'] || req.body.sampleOutput);
  const hiddenTestcases = parseTestcases(req.body['hiddenInput[]'] || req.body.hiddenInput, req.body['hiddenOutput[]'] || req.body.hiddenOutput);
  let tags = req.body['tags[]'] || req.body.tags || [];
  if (!Array.isArray(tags)) tags = [tags];
  await getProblems().insertOne({
    title, difficulty, statement, inputFormat, outputFormat,
    constraints: constraints || '', explanation: explanation || '',
    sampleTestcases, hiddenTestcases, testcases: [...sampleTestcases, ...hiddenTestcases],
    tags, timeLimit: parseInt(timeLimit) || 2,
    author: req.session.user.username, createdAt: new Date().toISOString()
  });
  res.redirect('/problems');
});

app.get('/problems/:id', async (req, res) => {
  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  problem.id = problem._id.toString();
  const user = req.session.user || null;
  const allProblemSubs = await getSubmissions().find({ problemId: problem.id }).toArray();
  problem.totalSubmissions = allProblemSubs.length;
  problem.acceptedSubmissions = allProblemSubs.filter(s => s.verdict === 'Accepted').length;
  const mySubmissions = user ? allProblemSubs.filter(s => s.username === user.username).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)).slice(0, 5) : [];
  res.render('problem-detail', { user, problem, mySubmissions });
});

app.post('/problems/:id/submit', requireLogin, async (req, res) => {
  const { code, language } = req.body;
  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  problem.id = problem._id.toString();
  const allTestcases = problem.testcases || [...(problem.sampleTestcases || []), ...(problem.hiddenTestcases || [])];
  const result = judgeCode(code, language, allTestcases, problem.timeLimit);
  const submission = {
    username: req.session.user.username, problemId: problem.id, problemTitle: problem.title,
    language, verdict: result.verdict, passedCount: result.passedCount, total: result.total,
    execTime: result.execTime, code, submittedAt: new Date().toISOString()
  };
  const inserted = await getSubmissions().insertOne(submission);
  res.render('submission-result', { user: req.session.user, result, problemId: problem.id, submissionId: inserted.insertedId.toString() });
});

app.get('/problems/:id/edit', requireLogin, async (req, res) => {
  let problem;
  try { problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  if (problem.author !== req.session.user.username) return res.redirect('/problems/' + req.params.id);
  problem.id = problem._id.toString();
  res.render('edit-problem', { user: req.session.user, problem, error: undefined });
});

app.post('/problems/:id/edit', requireLogin, async (req, res) => {
  const { title, difficulty, statement, inputFormat, outputFormat, timeLimit, constraints, explanation } = req.body;
  const sampleTestcases = parseTestcases(req.body['sampleInput[]'] || req.body.sampleInput, req.body['sampleOutput[]'] || req.body.sampleOutput);
  const hiddenTestcases = parseTestcases(req.body['hiddenInput[]'] || req.body.hiddenInput, req.body['hiddenOutput[]'] || req.body.hiddenOutput);
  let tags = req.body['tags[]'] || req.body.tags || [];
  if (!Array.isArray(tags)) tags = [tags];
  try {
    await getProblems().updateOne({ _id: new ObjectId(req.params.id) }, { $set: {
      title, difficulty, statement, inputFormat, outputFormat,
      constraints: constraints || '', explanation: explanation || '',
      sampleTestcases, hiddenTestcases, testcases: [...sampleTestcases, ...hiddenTestcases],
      tags, timeLimit: parseInt(timeLimit) || 2
    }});
  } catch (e) { return res.redirect('/problems'); }
  res.redirect('/problems/' + req.params.id);
});

app.post('/problems/:id/delete', requireLogin, async (req, res) => {
  try {
    const problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
    if (!problem || problem.author !== req.session.user.username) return res.redirect('/problems');
    await getProblems().deleteOne({ _id: new ObjectId(req.params.id) });
  } catch (e) {}
  res.redirect('/problems');
});

// ─── SUBMISSION DETAIL ────────────────────────────────────

app.get('/submissions/:id', requireLogin, async (req, res) => {
  let submission;
  try { submission = await getSubmissions().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/'); }
  if (!submission || submission.username !== req.session.user.username) return res.redirect('/');
  submission.id = submission._id.toString();
  res.render('submission-detail', { user: req.session.user, submission });
});

// ─── PROFILE ──────────────────────────────────────────────

app.get('/profile/:username', async (req, res) => {
  const targetUser = await getUsers().findOne({ username: req.params.username });
  if (!targetUser) return res.redirect('/');
  const userSubs = await getSubmissions().find({ username: req.params.username }).sort({ submittedAt: -1 }).toArray();
  const solvedSet = new Set(userSubs.filter(s => s.verdict === 'Accepted').map(s => s.problemId));
  const langStats = {};
  userSubs.forEach(s => { langStats[s.language] = (langStats[s.language] || 0) + 1; });
  const stats = {
    totalSubmissions: userSubs.length, solved: solvedSet.size,
    accepted: userSubs.filter(s => s.verdict === 'Accepted').length,
    wrongAnswer: userSubs.filter(s => s.verdict === 'Wrong Answer').length,
    tle: userSubs.filter(s => s.verdict === 'Time Limit Exceeded').length,
    re: userSubs.filter(s => s.verdict === 'Runtime Error').length,
    ce: userSubs.filter(s => s.verdict === 'Compilation Error').length,
    langStats
  };
  const recentSubmissions = userSubs.slice(0, 20).map(s => ({ ...s, id: s._id.toString() }));
  res.render('profile', {
    user: req.session.user || null,
    targetUser: { username: targetUser.username, email: targetUser.email, createdAt: targetUser._id.getTimestamp().toISOString() },
    stats, recentSubmissions
  });
});

// ─── ORGANIZATIONS ────────────────────────────────────────

app.get('/organizations', async (req, res) => {
  const organizations = await getOrgs().find().toArray();
  const orgsWithId = organizations.map(o => ({ ...o, id: o._id.toString() }));
  res.render('organizations', { user: req.session.user || null, organizations: orgsWithId });
});

app.get('/organizations/create', requireLogin, (req, res) => {
  res.render('create-organization', { user: req.session.user, error: undefined });
});

app.post('/organizations/create', requireLogin, async (req, res) => {
  const { name, description } = req.body;
  if (!name || name.trim().length < 3)
    return res.render('create-organization', { user: req.session.user, error: 'Organization name must be at least 3 characters.' });
  if (await getOrgs().findOne({ name: name.trim() }))
    return res.render('create-organization', { user: req.session.user, error: 'Organization name already exists.' });
  const result = await getOrgs().insertOne({
    name: name.trim(), description: description || '',
    owner: req.session.user.username, members: [req.session.user.username]
  });
  res.redirect('/organizations/' + result.insertedId.toString());
});

app.get('/organizations/:id', async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/organizations'); }
  if (!org) return res.redirect('/organizations');
  org.id = org._id.toString();
  const allContests = await getContests().find({ orgId: org.id }).toArray();
  const contests = allContests.map(c => ({ ...c, id: c._id.toString() }));
  res.render('organization-detail', { user: req.session.user || null, org, contests });
});

app.get('/organizations/:id/join', requireLogin, async (req, res) => {
  try { await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $addToSet: { members: req.session.user.username } }); } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.get('/organizations/:id/leave', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (org && org.owner !== req.session.user.username)
      await getOrgs().updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { members: req.session.user.username } });
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.get('/organizations/:id/contests/create', requireLogin, async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/organizations'); }
  if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations');
  org.id = org._id.toString();
  const problems = (await getProblems().find().toArray()).map(p => ({ ...p, id: p._id.toString() }));
  res.render('create-contest', { user: req.session.user, orgId: org.id, problems, error: undefined });
});

app.post('/organizations/:id/contests/create', requireLogin, async (req, res) => {
  let org;
  try { org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/organizations'); }
  if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations');

  const { name, timezone, noTimeLimit } = req.body;
  let problemIds = req.body['problemIds[]'] || req.body.problemIds || [];
  if (!Array.isArray(problemIds)) problemIds = [problemIds];

  const isNoLimit = noTimeLimit === 'on';
  const startTimeUTC = isNoLimit ? null : toUTC(req.body.startTime, timezone);
  const endTimeUTC = isNoLimit ? null : toUTC(req.body.endTime, timezone);

  await getContests().insertOne({
    name, orgId: org._id.toString(),
    timezone: timezone || 'UTC',
    noTimeLimit: isNoLimit,
    startTime: req.body.startTime || null,
    endTime: req.body.endTime || null,
    startTimeUTC, endTimeUTC,
    problemIds
  });
  res.redirect('/organizations/' + org._id.toString());
});

// ─── EDIT CONTEST ─────────────────────────────────────────

app.get('/contests/:id/edit', requireLogin, async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');

  const org = await getOrgs().findOne({ id: contest.orgId });
  const orgOwner = org ? org.owner : null;
  if (req.session.user.username !== orgOwner) {
    // Try finding org by string id
    const orgs = await getOrgs().find().toArray();
    const matchOrg = orgs.find(o => o._id.toString() === contest.orgId);
    if (!matchOrg || matchOrg.owner !== req.session.user.username) return res.redirect('/contests/' + req.params.id);
  }

  contest.id = contest._id.toString();
  const problems = (await getProblems().find().toArray()).map(p => ({ ...p, id: p._id.toString() }));
  res.render('edit-contest', { user: req.session.user, contest, problems, error: undefined });
});

app.post('/contests/:id/edit', requireLogin, async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');

  const orgs = await getOrgs().find().toArray();
  const matchOrg = orgs.find(o => o._id.toString() === contest.orgId);
  if (!matchOrg || matchOrg.owner !== req.session.user.username) return res.redirect('/contests/' + req.params.id);

  const { name, timezone, noTimeLimit } = req.body;
  let problemIds = req.body['problemIds[]'] || req.body.problemIds || [];
  if (!Array.isArray(problemIds)) problemIds = [problemIds];

  const isNoLimit = noTimeLimit === 'on';
  const startTimeUTC = isNoLimit ? null : toUTC(req.body.startTime, timezone);
  const endTimeUTC = isNoLimit ? null : toUTC(req.body.endTime, timezone);

  await getContests().updateOne({ _id: new ObjectId(req.params.id) }, { $set: {
    name, timezone: timezone || 'UTC',
    noTimeLimit: isNoLimit,
    startTime: req.body.startTime || null,
    endTime: req.body.endTime || null,
    startTimeUTC, endTimeUTC, problemIds
  }});
  res.redirect('/contests/' + req.params.id);
});

// ─── CONTEST DETAIL ───────────────────────────────────────

app.get('/contests/:id', async (req, res) => {
  let contest;
  try { contest = await getContests().findOne({ _id: new ObjectId(req.params.id) }); }
  catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');
  contest.id = contest._id.toString();

  const allProblems = await getProblems().find().toArray();
  const problems = allProblems.filter(p => contest.problemIds.includes(p._id.toString())).map(p => ({ ...p, id: p._id.toString() }));

  // Find org owner
  const orgs = await getOrgs().find().toArray();
  const matchOrg = orgs.find(o => o._id.toString() === contest.orgId);
  const isOwner = req.session.user && matchOrg && matchOrg.owner === req.session.user.username;

  const startUTC = contest.startTimeUTC || contest.startTime;
  const endUTC = contest.endTimeUTC || contest.endTime;

  let allSubs;
  if (contest.noTimeLimit) {
    allSubs = await getSubmissions().find({ problemId: { $in: contest.problemIds } }).toArray();
  } else {
    allSubs = await getSubmissions().find({
      problemId: { $in: contest.problemIds },
      submittedAt: { $gte: startUTC, $lte: endUTC }
    }).toArray();
  }

  const scoreMap = {};
  allSubs.forEach(s => {
    if (!scoreMap[s.username]) scoreMap[s.username] = { solved: new Set(), lastAC: null };
    if (s.verdict === 'Accepted') {
      scoreMap[s.username].solved.add(s.problemId);
      if (!scoreMap[s.username].lastAC || s.submittedAt > scoreMap[s.username].lastAC)
        scoreMap[s.username].lastAC = s.submittedAt;
    }
  });

  const scoreboard = Object.entries(scoreMap)
    .map(([username, data]) => ({ username, solved: data.solved.size, lastAC: data.lastAC }))
    .sort((a, b) => b.solved - a.solved || new Date(a.lastAC) - new Date(b.lastAC));

  res.render('contest-detail', {
    user: req.session.user || null, contest: { ...contest, startTimeUTC: startUTC, endTimeUTC: endUTC },
    problems, scoreboard, isOwner
  });
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