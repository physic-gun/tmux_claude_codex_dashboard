export function buildTmuxArgs({ socket, conf, managedExternally }, args = []) {
  const options = [];
  // An externally supervised tmux server must be the only process allowed to create the socket.
  // Without -N, commands such as new-session may silently start a replacement inside Node's cgroup.
  if (managedExternally) options.push('-N');
  options.push('-L', socket);
  if (conf) options.push('-f', conf);
  return [...options, ...args];
}
