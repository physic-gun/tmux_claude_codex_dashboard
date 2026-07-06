interface Tip {
  keys: string;
  desc: string;
}

const TIPS: Tip[] = [
  { keys: 'a / i', desc: '非输入状态下按 a 或 i 进入插入模式，恢复正常输入（claude 的 vim 模式，不是 bug）' },
  { keys: '/rewind', desc: '撤回上一个 prompt' },
  { keys: '/resume', desc: '恢复 / 继续之前的会话（也可点右上 🕘 会话历史一键 resume）' },
  { keys: '/rename', desc: '给当前会话命名（选项卡名会跟随它）' },
  { keys: 'Alt + Enter', desc: 'claude 输入框里换行（直接按 Enter 是发送）' },
  { keys: 'Ctrl + G', desc: '打开多行输入框，便于粘贴 / 编辑长文本（草稿按选项卡自动保存）' },
  { keys: '拖选即复制', desc: '鼠标拖选终端文字，松手即自动复制（无需开关）；右键整词选中。需经 https/localhost（安全上下文）剪贴板才可用' },
  { keys: '按住 Alt/Opt 拖动', desc: '进入「鼠标模式」：把点击和拖动转发给 claude（操作它的鼠标界面）；松开修饰键，普通拖选仍是复制' },
  { keys: 'Ctrl/Cmd + Shift + V', desc: '从剪贴板粘贴到终端（普通 Ctrl+V 不会粘贴，会提示用此组合；Mac 也可直接 Cmd+V）' },
  { keys: '📋 剪贴板中转', desc: 'claude 里 /copy 或拖选复制的内容会存到右下角 📋 列表（即使系统剪贴板被浏览器拦截也不丢）；点某条可编辑后「发送」回 claude、复制或删除' },
  { keys: '📄 文件预览', desc: '在 📋 里点开的内容若是文件路径（绝对路径，或相对 claude 当前运行目录），会自动在下方分栏只读预览文件；📄 栏 MD/原文 切换 Markdown 渲染，⛶ 放大为悬浮窗查阅、复制全文' },
  { keys: '滚轮 / 滚动按钮', desc: 'claude 里滚自己的视图，普通 shell 里滚 tmux 历史；右侧滚动条 ▲▲/▲/▼/▼▼ 可长按连续；Shift+滚轮强制本地回滚' },
  { keys: 'A+ / A−', desc: '右侧滚动条上方按钮：增大 / 缩小终端文字（中间数字是当前界面行数）' },
  { keys: '新建窗口', desc: '选项卡栏 ＋ 新建；留空回车 = 随机命名；支持批量 name[[1-5]]（不能用纯数字名）' },
  { keys: '管理分组', desc: '左侧「管理」按钮：进入后可上移 / 下移排序、删除分组（删除按钮平时隐藏）' },
  { keys: 'Ctrl+Alt+1 / 2 / 3', desc: '收起 / 展开：① 左侧分组栏 ② 选项卡栏 ③ 右侧源代码管理栏（终端聚焦时也生效）' },
  { keys: '快捷命令', desc: '左侧栏底部「快捷命令」区可折叠；展开时拖动顶部边缘可调整其高度' },
];

export default function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal help-modal">
        <div className="modal-title">快捷键 &amp; 使用提示</div>
        <table className="help-table">
          <tbody>
            {TIPS.map((t) => (
              <tr key={t.keys}>
                <td><kbd>{t.keys}</kbd></td>
                <td>{t.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
