const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

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

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function judgeCode(code, language, testcases) {
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const details = [];
  let passedCount = 0;

  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    if (!tc.input || !tc.output) {
      details.push({ passed: false, output: 'No test case data', expected: '' });
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
      } else if (language === 'cpp') {
        const codeFile = path.join(tmpDir, 'solution.cpp');
        const outFile = path.join(tmpDir, 'solution');
        fs.writeFileSync(codeFile, code);
        execSync(`g++ -o ${outFile} ${codeFile}`, { timeout: 10000 });
        output = execSync(`${outFile} < ${inputFile}`, { timeout: 5000 }).toString().trim();
      } else if (language === 'c') {
        const codeFile = path.join(tmpDir, 'solution.c');
        const outFile = path.join(tmpDir, 'solutionc');
        fs.writeFileSync(codeFile, code);
        execSync(`gcc -o ${outFile} ${codeFile}`, { timeout: 10000 });
        output = execSync(`${outFile} < ${inputFile}`, { timeout: 5000 }).toString().trim();
      } else if (language === 'java') {
        const codeFile = path.join(tmpDir, 'Main.java');
        fs.writeFileSync(codeFile, code);
        execSync(`javac ${codeFile}`, { timeout: 10000, cwd: tmpDir });
        output = execSync(`java -cp ${tmpDir} Main < ${inputFile}`, { timeout: 5000 }).toString().trim();
      }

      const expected = tc.output.trim();
      const passed = output === expected;
      if (passed) passedCount++;
      details.push({ passed, output, expected });
    } catch (e) {
      details.push({ passed: false, output: e.message || e.toString(), expected: tc.output.trim() });
    }
  }

  return { passed: passedCount === testcases.length, passedCount, total: testcases.length, details };
}

app.get('/', (req, res) => {
  res.render('index', { user: req.session.user || null });
});

app.get('/login', (req, res) => {
  res.render('login', {});
});

app.get('/register', (req, res) => {
  res.render('register', {});
});

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

  console.log(`Verification code for ${email}: ${verifyCode}`);
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

app.get('/problems', (req, res) => {
  const problems = getProblems();
  res.render('problems', { user: req.session.user || null, problems });
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
  res.render('problem-detail', { user: req.session.user || null, problem });
});

app.post('/problems/:id/submit', requireLogin, (req, res) => {
  const { code, language } = req.body;
  const problems = getProblems();
  const problem = problems.find(p => p.id === req.params.id);
  if (!problem) return res.redirect('/problems');

  const result = judgeCode(code, language, problem.testcases);
  res.render('submission-result', { user: req.session.user, result, problemId: problem.id });
});

app.listen(3000, () => {
  console.log('DOJ server running on port 3000');
});