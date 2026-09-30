import { CANVAS_SHELL } from "../../core/html/shell.js";
import { BUTTON_TAG, buttonMarkup, iconButtonMarkup } from "../../core/html/markup.js";
import { BUNNY_MARK_SVG, iconSvg } from "../../core/html/icons.js";
import { wireNotice } from "../../ui/primitives/notice.js";
import { translate as tr } from '../i18n.js';

const TOOLBAR_BUNNY_MARK_SVG = iconSvg("bunny", { size: 16 });

function webToolbarChrome() {
  return `${iconButtonMarkup({ id: "t-rail", title: "项目与 Rabbitholes · S", ariaLabel: "展开或收起项目", ariaExpanded: "false", ariaControls: "web-rail", svgIconHtml: iconSvg("rail") })}`
    + `${iconButtonMarkup({ id: "t-new", title: `${tr('createTitle')} · N`, ariaLabel: tr('createTitle'), svgIconHtml: iconSvg("new") })}`;
}

export function mountWebShell() {
  document.documentElement.classList.add("web-canvas-active");
  document.body.classList.add("mode-canvas", "web-shell");
  document.body.innerHTML = `<div id="canvas-root">${CANVAS_SHELL}</div>
    <aside id="web-rail" class="web-rail" aria-label="Rabbitholes" tabindex="-1"></aside>
    <div id="project-create-modal" class="project-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-create-title" aria-hidden="true" hidden>
      <section class="project-create-card">
        <header class="project-create-header"><h2 id="project-create-title">创建项目</h2><button type="button" class="project-create-close" data-project-close aria-label="关闭">×</button></header>
        <label class="project-create-label">项目名称<input data-project-name type="text" placeholder="例如：个人学习" maxlength="120"></label>
        <p class="project-create-label">源文件夹</p>
        <button type="button" class="project-folder-pick" data-project-pick><span aria-hidden="true">＋</span><strong>添加 RabbitHole 可读取的文件夹</strong></button>
        <textarea data-project-roots class="project-create-roots" rows="2" placeholder="可以添加多个文件夹，每行一个"></textarea>
        <div class="project-create-info"><span aria-hidden="true">✦</span><span>项目可以保存 Rabbitholes、文件和自定义指令，帮助你持续推进工作。</span></div>
        <label class="project-create-memory">默认记忆 <select><option>跟随全局</option></select></label>
        <p class="project-create-status" data-project-create-status role="status"></p>
        <footer class="project-create-actions"><button type="button" data-project-cancel>取消</button><button type="button" class="web-primary" data-project-create>创建项目</button></footer>
      </section>
    </div>
    <div id="composer-modal" class="composer-modal" hidden>
      <div class="composer-card" id="composer-card" tabindex="-1">
        <p class="composer-project">${tr('project')} · <strong data-current-project></strong></p>
        <section id="composer-start" class="composer-start">
          <header class="composer-start-head">
            <span class="composer-title-mark" aria-hidden="true">${BUNNY_MARK_SVG}</span>
            <h1 id="composer-title">${tr('createTitle')}</h1>
          </header>
          <div class="composer-paths" role="group" aria-label="Choose how to begin">
            ${['ask','file','paste','url'].map((key, index) => `<${BUTTON_TAG} class="composer-path" id="composer-path-${key}" type="button" data-path="${key}"><span class="composer-path-icon" aria-hidden="true">${iconSvg(['question','file','paste','link'][index])}</span><span class="composer-path-copy"><strong>${tr(key)}</strong><small>${tr(key+'Hint')}</small></span><span class="composer-path-arrow" aria-hidden="true">→</span></button>`).join('')}
          </div>
        </section>
        <section id="composer-entry" class="composer-entry" hidden>
          <${BUTTON_TAG} id="composer-back" class="composer-back" type="button"><span aria-hidden="true">←</span> ${tr('back')}</button>
          <header class="composer-entry-head"><h2 id="composer-entry-title"></h2><p id="composer-entry-copy"></p></header>
          <textarea id="composer-input" rows="1" autocomplete="off" spellcheck="true"></textarea>
          <div class="composer-entry-actions"><${BUTTON_TAG} id="composer-primary" class="web-primary" type="button"></button></div>
        </section>
        <input id="file-md" type="file" accept=".md,.markdown,.pdf,.rabbithole,.html,text/markdown,text/plain,text/html,application/pdf,application/json" hidden>
        <div id="ingest-status" class="ingest-status" aria-live="polite" aria-atomic="true"></div>
      </div>
    </div>
    <div id="blank-start" class="blank-start" hidden>
      <span id="blank-start-new-wrap" class="blank-start-new-wrap">${buttonMarkup({ bare: true, id: "blank-start-new", className: "blank-start-new", label: tr('createTitle'), kbdHint: "N", svgIconHtml: iconSvg("plus") })}<span id="blank-start-status" class="blank-start-tooltip" role="tooltip">可以直接导入文档，提问时需要连接模型。</span></span>
      ${buttonMarkup({ bare: true, id: "blank-start-setup", className: "blank-start-setup", label: "Set up AI" })}
    </div>
    <nav id="project-menu" class="project-menu popover-surface" role="menu" aria-label="Rabbithole project" hidden>
      <div class="project-menu-head" role="presentation"><span class="project-menu-mark" aria-hidden="true">${BUNNY_MARK_SVG}</span><span><strong>Rabbithole</strong><small>Open source · MIT</small></span></div>
      <a class="project-menu-item" role="menuitem" href="/about/" target="_blank" rel="noopener noreferrer"><span>About Rabbithole</span><span aria-hidden="true">↗</span></a>
      <a class="project-menu-item" role="menuitem" href="/about/#install" target="_blank" rel="noopener noreferrer"><span>Install &amp; self-host</span><span aria-hidden="true">↗</span></a>
      <a class="project-menu-item project-menu-github" role="menuitem" href="https://github.com/shlokkhemani/rabbithole" target="_blank" rel="noopener noreferrer"><span>GitHub</span><span class="project-menu-meta"><span id="project-github-stars" class="github-star-count" aria-label="GitHub stars"><span aria-hidden="true">★</span> Stars</span><span aria-hidden="true">↗</span></span></a>
    </nav>
    <div id="web-toast" class="web-toast"><span data-notice-message></span>${buttonMarkup({ bare: true, label: "Action", hidden: true, dataAttrs: { noticeAction: "" } })}</div>`;
  const notice = wireNotice(document.getElementById("web-toast"), { variant: "toast" });
  document.title = 'DSHPlugin-RabbitHole';
  const status = document.createElement('div');
  status.textContent = window.__dshpluginStatus?.generation ? 'DSHPlugin-RabbitHole · 当前 DSH 宿主 · 项目只读' : 'DSHPlugin-RabbitHole · 独立画布预览 · 提问请在 DSH 宿主中使用';
  status.setAttribute('role', 'status');
  status.style.cssText = 'position:fixed;bottom:12px;right:16px;z-index:30;font-size:11px;opacity:.7;pointer-events:none';
  document.body.appendChild(status);
  document.getElementById("tb-app")?.insertAdjacentHTML("afterbegin",
    `${iconButtonMarkup({ className: "toolbar-brand", id: "t-project", title: "About Rabbithole and project links", ariaLabel: "Rabbithole project menu", ariaHaspopup: "menu", ariaControls: "project-menu", ariaExpanded: "false", svgIconHtml: TOOLBAR_BUNNY_MARK_SVG })}<span class="sep toolbar-brand-sep"></span>${webToolbarChrome()}`);
  return notice;
}
