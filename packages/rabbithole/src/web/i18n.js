const messages = {
  'zh-CN': {
    createTitle: '新建 Rabbithole', project: '创建到项目', back: '返回',
    ask: '提问', askHint: '从一个想弄明白的问题开始', askPlaceholder: '写下你的问题…', askAction: '开始探索',
    file: '打开文档', fileHint: 'PDF、Markdown 或已有 Rabbithole',
    paste: '粘贴文本 / Markdown', pasteHint: '保留原文结构，进入分支阅读', pastePlaceholder: '粘贴文本或 Markdown…',
    url: '打开链接', urlHint: '文章、论文或网页', urlPlaceholder: 'https://…', openAction: '打开并阅读',
  },
  en: { createTitle: 'New Rabbithole', project: 'Create in project', back: 'Back', ask: 'Ask a question', askHint: 'Begin with a question', askPlaceholder: 'Your question…', askAction: 'Explore', file: 'Open a document', fileHint: 'PDF, Markdown or Rabbithole', paste: 'Paste text / Markdown', pasteHint: 'Keep the source structure', pastePlaceholder: 'Paste text…', url: 'Open a link', urlHint: 'Article, paper or webpage', urlPlaceholder: 'https://…', openAction: 'Open and read' },
};
export function translate(key) { return (messages[localStorage.getItem('rh-locale') || 'zh-CN'] || messages['zh-CN'])[key] || messages['zh-CN'][key] || key; }
