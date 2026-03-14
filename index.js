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

// ─── MONGODB ──────────────────────────────────────────────
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

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

async function sendEmail(to, subject, htmlContent) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'DOJ - Dary Online Judge', email: process.env.GMAIL_USER },
      to: [{ email: to }],
      subject,
      htmlContent
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }
}

function judgeCode(code, language, testcases) {
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

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

    try {
      let output = '';
      if (language === 'python') {
        const codeFile = path.join(tmpDir, 'solution.py');
        fs.writeFileSync(codeFile, code);
        output = execSync(`python3 ${codeFile} < ${inputFile}`, { timeout: 5000 }).toString().trim();
      } else if (language === 'cpp' || language === 'c') {
        output = execSync(`${compiledPath} < ${inputFile}`, { timeout: 5000 }).toString().trim();
      } else if (language === 'java') {
        output = execSync(`java -cp ${tmpDir} Main < ${inputFile}`, { timeout: 10000 }).toString().trim();
      }

      const expected = tc.output.trim();
      const passed = output === expected;
      if (passed) passedCount++;
      details.push({ status: passed ? 'AC' : 'WA', passed, output, expected });

    } catch (e) {
      const isTimeout = e.signal === 'SIGTERM' || (e.message && e.message.includes('ETIMEDOUT'));
      if (isTimeout) {
        details.push({ status: 'TLE', passed: false, output: 'Time Limit Exceeded', expected: tc.output.trim() });
      } else {
        const errMsg = e.stderr ? e.stderr.toString().split('\n')[0] : (e.message || 'Runtime Error');
        details.push({ status: 'RE', passed: false, output: errMsg, expected: tc.output.trim() });
      }
    }
  }

  const allPassed = passedCount === testcases.length;
  let verdict = 'Accepted';
  if (!allPassed) {
    const firstFail = details.find(d => !d.passed);
    if (firstFail) verdict = firstFail.status === 'TLE' ? 'Time Limit Exceeded'
                           : firstFail.status === 'RE' ? 'Runtime Error'
                           : 'Wrong Answer';
  }

  return { verdict, passed: allPassed, passedCount, total: testcases.length, details };
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
    await sendEmail(email, 'DOJ - Email Verification Code', `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <h2 style="color: #00e5a0;">Dary Online Judge</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing: 8px; color: #0f0f23; background: #00e5a0; padding: 16px; text-align: center; border-radius: 8px;">${verifyCode}</h1>
        <p>This code will expire in 10 minutes.</p>
      </div>
    `);
  } catch (e) {
    console.error('Email error:', e.message);
  }
  res.redirect('/verify');
});

app.get('/verify', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/register');
  res.render('verify', { error: undefined });
});

app.post('/verify', async (req, res) => {
  const { code } = req.body;
  if (code === req.session.verifyCode) {
    await getUsers().insertOne(req.session.pendingUser);
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
  req.session.user = { username: user.username, email: user.email };
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── FORGOT PASSWORD ──────────────────────────────────────

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: undefined, success: undefined });
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await getUsers().findOne({ email });
  if (!user)
    return res.render('forgot-password', { error: 'No account found with that email.', success: undefined });

  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.resetEmail = email;
  req.session.resetCode = resetCode;

  try {
    await sendEmail(email, 'DOJ - Password Reset Code', `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <h2 style="color: #00e5a0;">Dary Online Judge</h2>
        <p>Your password reset code is:</p>
        <h1 style="letter-spacing: 8px; color: #0f0f23; background: #00e5a0; padding: 16px; text-align: center; border-radius: 8px;">${resetCode}</h1>
        <p>This code will expire in 10 minutes.</p>
      </div>
    `);
  } catch (e) {
    console.error('Email error:', e.message);
  }
  res.redirect('/reset-password');
});

app.get('/reset-password', (req, res) => {
  if (!req.session.resetEmail) return res.redirect('/forgot-password');
  res.render('reset-password', { error: undefined });
});

app.post('/reset-password', async (req, res) => {
  const { code, password, confirmPassword } = req.body;
  if (code !== req.session.resetCode)
    return res.render('reset-password', { error: 'Invalid reset code.' });
  if (password.length < 6)
    return res.render('reset-password', { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword)
    return res.render('reset-password', { error: 'Passwords do not match.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await getUsers().updateOne({ email: req.session.resetEmail }, { $set: { password: hashedPassword } });
  req.session.resetEmail = null;
  req.session.resetCode = null;
  res.redirect('/login');
});

// ─── CHANGE PASSWORD ──────────────────────────────────────

app.get('/change-password', requireLogin, (req, res) => {
  res.render('change-password', { user: req.session.user, error: undefined, success: undefined });
});

app.post('/change-password', requireLogin, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await getUsers().findOne({ username: req.session.user.username });
  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match)
    return res.render('change-password', { user: req.session.user, error: 'Current password is incorrect.', success: undefined });
  if (newPassword.length < 6)
    return res.render('change-password', { user: req.session.user, error: 'New password must be at least 6 characters.', success: undefined });
  if (newPassword !== confirmPassword)
    return res.render('change-password', { user: req.session.user, error: 'Passwords do not match.', success: undefined });

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await getUsers().updateOne({ username: req.session.user.username }, { $set: { password: hashedPassword } });
  res.render('change-password', { user: req.session.user, error: undefined, success: 'Password changed successfully!' });
});

// ─── PROBLEMS ─────────────────────────────────────────────

app.get('/problems', async (req, res) => {
  const problems = await getProblems().find().toArray();
  const user = req.session.user || null;

  const solvedSet = new Set();
  if (user) {
    const solvedSubs = await getSubmissions().find({ username: user.username, verdict: 'Accepted' }).toArray();
    solvedSubs.forEach(s => solvedSet.add(s.problemId));
  }

  const problemsWithStatus = problems.map(p => ({
    ...p,
    id: p._id.toString(),
    solved: solvedSet.has(p._id.toString())
  }));

  res.render('problems', { user, problems: problemsWithStatus });
});

app.get('/problems/create', requireLogin, (req, res) => {
  res.render('create-problem', { user: req.session.user, error: undefined });
});

app.post('/problems/create', requireLogin, async (req, res) => {
  const { title, difficulty, statement, inputFormat, outputFormat } = req.body;

  const tcInputRaw = req.body['tcInput[]'] || req.body.tcInput;
  const tcOutputRaw = req.body['tcOutput[]'] || req.body.tcOutput;
  let tcInput = Array.isArray(tcInputRaw) ? tcInputRaw : [tcInputRaw];
  let tcOutput = Array.isArray(tcOutputRaw) ? tcOutputRaw : [tcOutputRaw];

  const testcases = tcInput.map((inp, i) => ({
    input: inp || '', output: tcOutput[i] || ''
  })).filter(tc => tc.input && tc.output);

  const result = await getProblems().insertOne({
    title, difficulty, statement, inputFormat, outputFormat, testcases,
    author: req.session.user.username,
    createdAt: new Date().toISOString()
  });

  res.redirect('/problems');
});

app.get('/problems/:id', async (req, res) => {
  let problem;
  try {
    problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');

  problem.id = problem._id.toString();
  const user = req.session.user || null;

  const mySubmissions = user
    ? await getSubmissions().find({ username: user.username, problemId: problem.id })
        .sort({ submittedAt: -1 }).limit(5).toArray()
    : [];

  res.render('problem-detail', { user, problem, mySubmissions });
});

app.post('/problems/:id/submit', requireLogin, async (req, res) => {
  const { code, language } = req.body;
  let problem;
  try {
    problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');

  problem.id = problem._id.toString();
  const result = judgeCode(code, language, problem.testcases);

  const submission = {
    username: req.session.user.username,
    problemId: problem.id,
    problemTitle: problem.title,
    language,
    verdict: result.verdict,
    passedCount: result.passedCount,
    total: result.total,
    code,
    submittedAt: new Date().toISOString()
  };
  const inserted = await getSubmissions().insertOne(submission);

  res.render('submission-result', {
    user: req.session.user,
    result,
    problemId: problem.id,
    submissionId: inserted.insertedId.toString()
  });
});

// ─── EDIT / DELETE PROBLEM ────────────────────────────────

app.get('/problems/:id/edit', requireLogin, async (req, res) => {
  let problem;
  try {
    problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/problems'); }
  if (!problem) return res.redirect('/problems');
  if (problem.author !== req.session.user.username) return res.redirect('/problems/' + req.params.id);

  problem.id = problem._id.toString();
  res.render('edit-problem', { user: req.session.user, problem, error: undefined });
});

app.post('/problems/:id/edit', requireLogin, async (req, res) => {
  const { title, difficulty, statement, inputFormat, outputFormat } = req.body;
  const tcInputRaw = req.body['tcInput[]'] || req.body.tcInput;
  const tcOutputRaw = req.body['tcOutput[]'] || req.body.tcOutput;
  let tcInput = Array.isArray(tcInputRaw) ? tcInputRaw : [tcInputRaw];
  let tcOutput = Array.isArray(tcOutputRaw) ? tcOutputRaw : [tcOutputRaw];
  const testcases = tcInput.map((inp, i) => ({
    input: inp || '', output: tcOutput[i] || ''
  })).filter(tc => tc.input && tc.output);

  try {
    await getProblems().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { title, difficulty, statement, inputFormat, outputFormat, testcases } }
    );
  } catch (e) { return res.redirect('/problems'); }
  res.redirect('/problems/' + req.params.id);
});

app.post('/problems/:id/delete', requireLogin, async (req, res) => {
  try {
    const problem = await getProblems().findOne({ _id: new ObjectId(req.params.id) });
    if (!problem || problem.author !== req.session.user.username) return res.redirect('/problems');
    await getProblems().deleteOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/problems'); }
  res.redirect('/problems');
});

// ─── SUBMISSION DETAIL ────────────────────────────────────

app.get('/submissions/:id', requireLogin, async (req, res) => {
  let submission;
  try {
    submission = await getSubmissions().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/'); }
  if (!submission || submission.username !== req.session.user.username) return res.redirect('/');

  submission.id = submission._id.toString();
  res.render('submission-detail', { user: req.session.user, submission });
});

// ─── PROFILE ──────────────────────────────────────────────

app.get('/profile/:username', async (req, res) => {
  const targetUser = await getUsers().findOne({ username: req.params.username });
  if (!targetUser) return res.redirect('/');

  const userSubs = await getSubmissions().find({ username: req.params.username })
    .sort({ submittedAt: -1 }).toArray();

  const solvedSet = new Set(
    userSubs.filter(s => s.verdict === 'Accepted').map(s => s.problemId)
  );

  const stats = {
    totalSubmissions: userSubs.length,
    solved: solvedSet.size,
    accepted: userSubs.filter(s => s.verdict === 'Accepted').length,
    wrongAnswer: userSubs.filter(s => s.verdict === 'Wrong Answer').length,
    tle: userSubs.filter(s => s.verdict === 'Time Limit Exceeded').length,
    re: userSubs.filter(s => s.verdict === 'Runtime Error').length,
    ce: userSubs.filter(s => s.verdict === 'Compilation Error').length,
  };

  const recentSubmissions = userSubs.slice(0, 20).map(s => ({
    ...s,
    id: s._id.toString()
  }));

  res.render('profile', {
    user: req.session.user || null,
    targetUser: { username: targetUser.username, email: targetUser.email },
    stats,
    recentSubmissions
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
    name: name.trim(),
    description: description || '',
    owner: req.session.user.username,
    members: [req.session.user.username]
  });
  res.redirect('/organizations/' + result.insertedId.toString());
});

app.get('/organizations/:id', async (req, res) => {
  let org;
  try {
    org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/organizations'); }
  if (!org) return res.redirect('/organizations');

  org.id = org._id.toString();
  const allContests = await getContests().find({ orgId: org.id }).toArray();
  const contests = allContests.map(c => ({ ...c, id: c._id.toString() }));
  res.render('organization-detail', { user: req.session.user || null, org, contests });
});

app.get('/organizations/:id/join', requireLogin, async (req, res) => {
  try {
    await getOrgs().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $addToSet: { members: req.session.user.username } }
    );
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.get('/organizations/:id/leave', requireLogin, async (req, res) => {
  try {
    const org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
    if (org && org.owner !== req.session.user.username) {
      await getOrgs().updateOne(
        { _id: new ObjectId(req.params.id) },
        { $pull: { members: req.session.user.username } }
      );
    }
  } catch (e) {}
  res.redirect('/organizations/' + req.params.id);
});

app.get('/organizations/:id/contests/create', requireLogin, async (req, res) => {
  let org;
  try {
    org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/organizations'); }
  if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations');

  org.id = org._id.toString();
  const problems = (await getProblems().find().toArray()).map(p => ({ ...p, id: p._id.toString() }));
  res.render('create-contest', { user: req.session.user, orgId: org.id, problems, error: undefined });
});

app.post('/organizations/:id/contests/create', requireLogin, async (req, res) => {
  let org;
  try {
    org = await getOrgs().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/organizations'); }
  if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations');

  const { name, startTime, endTime } = req.body;
  let problemIds = req.body['problemIds[]'] || req.body.problemIds || [];
  if (!Array.isArray(problemIds)) problemIds = [problemIds];

  await getContests().insertOne({
    name,
    orgId: org._id.toString(),
    startTime,
    endTime,
    problemIds
  });
  res.redirect('/organizations/' + org._id.toString());
});

app.get('/contests/:id', async (req, res) => {
  let contest;
  try {
    contest = await getContests().findOne({ _id: new ObjectId(req.params.id) });
  } catch (e) { return res.redirect('/organizations'); }
  if (!contest) return res.redirect('/organizations');

  contest.id = contest._id.toString();
  const allProblems = await getProblems().find().toArray();
  const problems = allProblems
    .filter(p => contest.problemIds.includes(p._id.toString()))
    .map(p => ({ ...p, id: p._id.toString() }));

  const allSubs = await getSubmissions().find({
    problemId: { $in: contest.problemIds },
    submittedAt: { $gte: contest.startTime, $lte: contest.endTime }
  }).toArray();

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

  res.render('contest-detail', { user: req.session.user || null, contest, problems, scoreboard });
});

// ─── START ────────────────────────────────────────────────

connectDB().then(() => {
  app.listen(3000, () => console.log('DOJ server running on port 3000'));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});