// 沙盒用的假 Discord + 假 GitHub（同一個 HTTP 伺服器）。只給 security/ 的攻擊測試使用。
//   node security/mock-upstream.mjs [port]
// 控制端點：POST /__control {"user":{...},"member":true}、GET /__state、POST /__reset
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8799);
const REPO = '/repos/example/loadout-dashboard';
let state;
const reset = () => { state = {
  user: { id: '175928847299117063', username: 'tester', global_name: 'Tester', avatar: 'a1b2c3', discriminator: '0' },
  member: true, files: new Map(), branches: new Map(), pulls: [], requests: 0,
}; };
reset();

const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw.startsWith('{') ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://mock');
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
  const path = url.pathname;

  if (path === '/__control') { Object.assign(state, body); return send(200, {}); }
  if (path === '/__reset') { reset(); return send(200, {}); }
  if (path === '/__state') return send(200, { branches: [...state.branches.keys()], pulls: state.pulls.map(pull => ({ title: pull.title, ref: pull.head.ref })), files: Object.fromEntries([...state.branches].map(([name, tree]) => [name, Object.fromEntries(tree)])), requests: state.requests });
  state.requests += 1;

  // Discord
  if (path === '/discord/oauth2/token') return send(200, { access_token: 'discord-token' });
  if (path === '/discord/oauth2/token/revoke') return send(200, {});
  if (path === '/discord/users/@me') return send(200, state.user);
  if (path.startsWith('/discord/users/@me/guilds/')) return state.member ? send(200, { roles: [] }) : send(404, {});

  // GitHub
  if (path.endsWith('/access_tokens')) return send(201, { token: 'ghs_mock', expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const repoPath = path.replace('/github' + REPO, '');
  if (repoPath === '/git/ref/heads/main') return send(200, { object: { sha: 'a'.repeat(40) } });
  if (repoPath === '/git/refs' && req.method === 'POST') {
    const name = body.ref.replace('refs/heads/', '');
    if (state.branches.has(name)) return send(422, {});
    state.branches.set(name, new Map(state.files)); return send(201, {});
  }
  if (repoPath.startsWith('/git/refs/heads/') && req.method === 'PATCH') return send(200, {});
  if (repoPath === '/pulls' && req.method === 'GET') return send(200, state.pulls.filter(pull => url.searchParams.get('state') === 'all' || pull.state === 'open'));
  const comments = /^\/issues\/(\d+)\/comments$/.exec(repoPath);
  if (comments) return send(200, state.comments?.[comments[1]] ?? []);
  if (repoPath === '/pulls' && req.method === 'POST') {
    const pull = { number: state.pulls.length + 1, state: 'open', merged_at: null, title: body.title, html_url: `https://github.com/example/loadout-dashboard/pull/${state.pulls.length + 1}`, head: { ref: body.head, sha: `${String(state.pulls.length + 1).padStart(40, 'e')}`, repo: { full_name: 'example/loadout-dashboard' } } };
    state.pulls.push(pull); return send(201, pull);
  }
  if (repoPath.startsWith('/contents/')) {
    const file = decodeURIComponent(repoPath.slice('/contents/'.length));
    const ref = req.method === 'GET' ? url.searchParams.get('ref') : body.branch;
    const tree = ref === 'main' ? state.files : (state.branches.get(ref) ?? state.branches.get(state.pulls.find(pull => pull.head.sha === ref)?.head.ref));
    if (req.method === 'GET') {
      if (tree?.has(file)) return send(200, { sha: 'f'.repeat(40), content: Buffer.from(tree.get(file)).toString('base64') });
      const children = [...(tree?.keys() ?? [])].filter(name => name.startsWith(`${file}/`)).map(name => ({ name: name.slice(file.length + 1) }));
      return children.length ? send(200, children) : send(404, {});
    }
    if (!tree) return send(404, {});
    if (req.method === 'PUT') { tree.set(file, Buffer.from(body.content, 'base64').toString('utf8')); return send(201, {}); }
    if (req.method === 'DELETE') { tree.delete(file); return send(200, {}); }
  }
  send(500, { error: `mock: unexpected ${req.method} ${path}` });
});
server.listen(port, '127.0.0.1', () => console.log(`mock upstream on ${port}`));
