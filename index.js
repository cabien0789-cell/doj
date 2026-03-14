const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

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

const USERS_FILE = path.join(__dirname, 'data/users.json');
const PROBLEMS_FILE = path.join(__dirname, 'data/problems.json');
const ORGS_FILE = path.join(__dirname, 'data/organizations.json');
const CONTESTS_FILE = path.join(__dirname, 'data/contests.json');
const SUBMISSIONS_FILE = path.join(__dirname, 'data/submissions.json');

function getUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function getProblems() {
  if (!fs.existsSync(PROBLEMS_FILE)) fs.writeFileSync(PROBLEMS_FILE, '[]');
  return JSON.parse(fs.readFileSync(PROBLEMS_FILE, 'utf8'));
}
function saveProblems(problems) {
  fs.writeFileSync(PROBLEMS_FILE, JSON.stringify(problems, null, 2));
}
function getOrgs() {
  if (!fs.existsSync(ORGS_FILE)) fs.writeFileSync(ORGS_FILE, '[]');
  return JSON.parse(fs.readFileSync(ORGS_FILE, 'utf8'));
}
function saveOrgs(orgs) {
  fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
}
function getContests() {
  if (!fs.existsSync(CONTESTS_FILE)) fs.writeFileSync(CONTESTS_FILE, '[]');
  return JSON.parse(fs.readFileSync(CONTESTS_FILE, 'utf8'));
}
function saveContests(contests) {
  fs.writeFileSync(CONTESTS_FILE, JSON.stringify(contests, null, 2));
}
function getSubmissions() {
  if (!fs.existsSync(SUBMISSIONS_FILE)) fs.writeFileSync(SUBMISSIONS_FILE, '[]');
  return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
}
function saveSubmissions(submissions) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(submissions, null, 2));
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

async function sendVerificationEmail(email, code) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'DOJ - Dary Online Judge', email: process.env.GMAIL_USER },
      to: [{ email }],
      subject: 'DOJ - Email Verification Code',
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #00e5a0;">Dary Online Judge</h2>
          <p>Your verification code is:</p>
          <h1 style="letter-spacing: 8px; color: #0f0f23; background: #00e5a0; padding: 16px; text-align: center; border-radius: 8px;">${code}</h1>
          <p>This code will expire in 10 minutes.</p>
        </div>
      `
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

  // Compile once for compiled languages
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
    // Compilation Error — fail all test cases
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

app.get('/', (req, res) => {
  const problems = getProblems();
  const users = getUsers();
  const submissions = getSubmissions();
  res.render('index', {
    user: req.session.user || null,
    stats: { problems: problems.length, users: users.length, submissions: submissions.length }
  });
});

app.get('/login', (req, res) => res.render('login', {}));
app.get('/register', (req, res) => res.render('register', {}));

app.post('/register', async (req, res) => {
  const { username, password, confirmPassword, email } = req.body;
  const users = getUsers();

  if (username.length < 3 || username.length > 20)
    return res.render('register', { error: 'Username must be between 3 and 20 characters.' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.render('register', { error: 'Username can only contain letters, numbers, and underscores.' });
  if (users.find(u => u.username === username))
    return res.render('register', { error: 'Username already exists.' });
  if (password.length < 6)
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword)
    return res.render('register', { error: 'Passwords do not match.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.render('register', { error: 'Invalid email address.' });
  if (users.find(u => u.email === email))
    return res.render('register', { error: 'Email already in use.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

  req.session.pendingUser = { username, password: hashedPassword, email };
  req.session.verifyCode = verifyCode;

  try {
    await sendVerificationEmail(email, verifyCode);
  } catch (e) {
    console.error('Email error:', e.message);
  }
  res.redirect('/verify');
});

app.get('/verify', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/register');
  res.render('verify', { error: undefined });
});

app.post('/verify', (req, res) => {
  const { code } = req.body;
  if (code === req.session.verifyCode) {
    const users = getUsers();
    users.push(req.session.pendingUser);
    saveUsers(users);
    req.session.pendingUser = null;
    req.session.verifyCode = null;
    res.render('register-success');
  } else {
    res.render('verify', { error: 'Invalid verification code. Please try again.' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user = users.find(u => u.username === username);
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

// ─── PROBLEMS ─────────────────────────────────────────────

app.get('/problems', (req, res) => {
  const problems = getProblems();
  const submissions = getSubmissions();
  const user = req.session.user || null;

  // Mark which problems the current user has solved
  const solvedSet = new Set();
  if (user) {
    submissions.filter(s => s.username === user.username && s.verdict === 'Accepted')
               .forEach(s => solvedSet.add(s.problemId));
  }

  const problemsWithStatus = problems.map(p => ({
    ...p,
    solved: solvedSet.has(p.id)
  }));

  res.render('problems', { user, problems: problemsWithStatus });
});

app.get('/problems/create', requireLogin, (req, res) => {
  res.render('create-problem', { user: req.session.user, error: undefined });
});

app.post('/problems/create', requireLogin, (req, res) => {
  const { title, difficulty, statement, inputFormat, outputFormat } = req.body;

  const tcInputRaw = req.body['tcInput[]'] || req.body.tcInput;
  const tcOutputRaw = req.body['tcOutput[]'] || req.body.tcOutput;

  let tcInput = Array.isArray(tcInputRaw) ? tcInputRaw : [tcInputRaw];
  let tcOutput = Array.isArray(tcOutputRaw) ? tcOutputRaw : [tcOutputRaw];

  const testcases = tcInput.map((inp, i) => ({
    input: inp || '',
    output: tcOutput[i] || ''
  })).filter(tc => tc.input && tc.output);

  const problems = getProblems();
  const newProblem = {
    id: Date.now().toString(),
    title, difficulty, statement, inputFormat, outputFormat, testcases,
    author: req.session.user.username
  };

  problems.push(newProblem);
  saveProblems(problems);
  res.redirect('/problems');
});

app.get('/problems/:id', (req, res) => {
  const problems = getProblems();
  const problem = problems.find(p => p.id === req.params.id);
  if (!problem) return res.redirect('/problems');

  const submissions = getSubmissions();
  const user = req.session.user || null;

  // Last 5 submissions for this problem by this user
  const mySubmissions = user
    ? submissions.filter(s => s.username === user.username && s.problemId === problem.id)
                 .slice(-5).reverse()
    : [];

  res.render('problem-detail', { user, problem, mySubmissions });
});

app.post('/problems/:id/submit', requireLogin, (req, res) => {
  const { code, language } = req.body;
  const problems = getProblems();
  const problem = problems.find(p => p.id === req.params.id);
  if (!problem) return res.redirect('/problems');

  const result = judgeCode(code, language, problem.testcases);

  // Save submission
  const submissions = getSubmissions();
  const newSubmission = {
    id: Date.now().toString(),
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
  submissions.push(newSubmission);
  saveSubmissions(submissions);

  res.render('submission-result', {
    user: req.session.user,
    result,
    problemId: problem.id,
    submissionId: newSubmission.id
  });
});

// ─── PROFILE ──────────────────────────────────────────────

app.get('/profile/:username', (req, res) => {
  const users = getUsers();
  const targetUser = users.find(u => u.username === req.params.username);
  if (!targetUser) return res.redirect('/');

  const submissions = getSubmissions();
  const userSubs = submissions.filter(s => s.username === req.params.username);

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

  const recentSubmissions = userSubs.slice(-20).reverse();

  res.render('profile', {
    user: req.session.user || null,
    targetUser: { username: targetUser.username, email: targetUser.email },
    stats,
    recentSubmissions
  });
});

// ─── ORGANIZATIONS ────────────────────────────────────────

app.get('/organizations', (req, res) => {
  const organizations = getOrgs();
  res.render('organizations', { user: req.session.user || null, organizations });
});

app.get('/organizations/create', requireLogin, (req, res) => {
  res.render('create-organization', { user: req.session.user, error: undefined });
});

app.post('/organizations/create', requireLogin, (req, res) => {
  const { name, description } = req.body;
  const orgs = getOrgs();

  if (!name || name.trim().length < 3)
    return res.render('create-organization', { user: req.session.user, error: 'Organization name must be at least 3 characters.' });
  if (orgs.find(o => o.name === name.trim()))
    return res.render('create-organization', { user: req.session.user, error: 'Organization name already exists.' });

  const newOrg = {
    id: Date.now().toString(),
    name: name.trim(),
    description: description || '',
    owner: req.session.user.username,
    members: [req.session.user.username]
  };

  orgs.push(newOrg);
  saveOrgs(orgs);
  res.redirect('/organizations/' + newOrg.id);
});

app.get('/organizations/:id', (req, res) => {
  const orgs = getOrgs();
  const org = orgs.find(o => o.id === req.params.id);
  if (!org) return res.redirect('/organizations');

  const contests = getContests().filter(c => c.orgId === org.id);
  res.render('organization-detail', { user: req.session.user || null, org, contests });
});

app.get('/organizations/:id/join', requireLogin, (req, res) => {
  const orgs = getOrgs();
  const org = orgs.find(o => o.id === req.params.id);
  if (!org) return res.redirect('/organizations');

  if (!org.members.includes(req.session.user.username)) {
    org.members.push(req.session.user.username);
    saveOrgs(orgs);
  }
  res.redirect('/organizations/' + org.id);
});

app.get('/organizations/:id/leave', requireLogin, (req, res) => {
  const orgs = getOrgs();
  const org = orgs.find(o => o.id === req.params.id);
  if (!org) return res.redirect('/organizations');

  if (org.owner === req.session.user.username) return res.redirect('/organizations/' + org.id);

  org.members = org.members.filter(m => m !== req.session.user.username);
  saveOrgs(orgs);
  res.redirect('/organizations/' + org.id);
});

app.get('/organizations/:id/contests/create', requireLogin, (req, res) => {
  const orgs = getOrgs();
  const org = orgs.find(o => o.id === req.params.id);
  if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations');

  const problems = getProblems();
  res.render('create-contest', { user: req.session.user, orgId: org.id, problems, error: undefined });
});

app.post('/organizations/:id/contests/create', requireLogin, (req, res) => {
  const orgs = getOrgs();
  const org = orgs.find(o => o.id === req.params.id);
  if (!org || org.owner !== req.session.user.username) return res.redirect('/organizations');

  const { name, startTime, endTime } = req.body;
  let problemIds = req.body['problemIds[]'] || req.body.problemIds || [];
  if (!Array.isArray(problemIds)) problemIds = [problemIds];

  const contests = getContests();
  const newContest = {
    id: Date.now().toString(),
    name, orgId: org.id, startTime, endTime, problemIds
  };

  contests.push(newContest);
  saveContests(contests);
  res.redirect('/organizations/' + org.id);
});

app.get('/contests/:id', (req, res) => {
  const contests = getContests();
  const contest = contests.find(c => c.id === req.params.id);
  if (!contest) return res.redirect('/organizations');

  const allProblems = getProblems();
  const problems = allProblems.filter(p => contest.problemIds.includes(p.id));
  res.render('contest-detail', { user: req.session.user || null, contest, problems });
});

app.listen(3000, () => {
  console.log('DOJ server running on port 3000');
});