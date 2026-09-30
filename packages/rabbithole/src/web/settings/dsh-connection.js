export function connectionMarkup() {
  return `<details class="settings-advanced" id="dsh-connection"><summary>配置 API 连接</summary><div class="settings-advanced-grid">
  <small class="field-hint">DailyDesk 安装包自带 DSH。填写服务地址、模型与自己的 API key 后即可使用。已有 Codex / Claude Code 可在回答来源中选择。</small>
  <label class="field">服务地址<input id="dsh-endpoint" type="url" value="https://api.deepseek.com/v1" autocomplete="off"></label>
  <label class="field">协议<select id="dsh-protocol"><option value="openai-completions">OpenAI Chat Completions / DeepSeek</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Gemini</option></select></label>
  <label class="field">模型 ID<input id="dsh-connection-model" value="deepseek-flash" autocomplete="off"></label>
  <label class="field">API key<input id="dsh-api-key" type="password" autocomplete="new-password" placeholder="仅保存在当前 Windows 用户的加密存储中"></label>
  <label class="field">网页搜索的 DeepSeek API key（可选）<input id="dsh-search-key" type="password" autocomplete="new-password" placeholder="使用 DeepSeek 官方地址时自动复用上面的 key"></label>
  <small class="field-hint">DSH 网页搜索调用 DeepSeek 搜索服务；其它 endpoint 可单独填写此 key。项目文件读取和网页正文抓取不需要搜索 key。</small>
  <div class="settings-row"><label class="field">上下文长度<input id="dsh-context" type="number" value="65536" min="4096"></label><label class="field">输出上限<input id="dsh-output" type="number" value="8192" min="256"></label></div>
  <button id="dsh-save-connection" class="web-primary" type="button">保存并使用</button>
  <small id="dsh-connection-status" class="field-hint" role="status"></small>
  <small class="field-hint">保存后，独立审核使用此连接另开会话；审核记录保留。填写长度应与所选模型的服务说明一致。</small>
  </div></details>`;
}
export function wireConnection(host,applyPatch) {
  const box=host.querySelector('#dsh-connection');if(!box)return;
  const field=id=>box.querySelector(id),status=field('#dsh-connection-status');let edited=false;
  box.addEventListener('input',()=>{edited=true;});
  fetch('/api/runtime/connection').then(async r=>{if(!r.ok)throw Error('当前服务尚未提供连接配置');return r.json();}).then(config=>{
    if(!box.isConnected||edited)return;
    field('#dsh-endpoint').value=config.endpoint;field('#dsh-protocol').value=config.protocol;
    field('#dsh-connection-model').value=config.model;field('#dsh-context').value=config.contextWindow;field('#dsh-output').value=config.maxTokens;
    status.textContent=config.credentialError?'凭据无法解密，请重新填写 API key。':config.configured?'已有加密凭据；留空可保留。':config.bundled?'已发现随安装包提供的 DSH。':'使用本机 DSH；可在这里配置 API 连接。';
  }).catch(e=>{status.textContent=e.message;});
  field('#dsh-save-connection').addEventListener('click',async event=>{
    event.currentTarget.disabled=true;status.textContent='正在保存…';
    try{
      const response=await fetch('/api/runtime/connection',{method:'POST',headers:{'Content-Type':'application/json','X-DailyDesk-Request':'connection'},body:JSON.stringify({endpoint:field('#dsh-endpoint').value,protocol:field('#dsh-protocol').value,model:field('#dsh-connection-model').value,apiKey:field('#dsh-api-key').value,searchKey:field('#dsh-search-key').value,contextWindow:Number(field('#dsh-context').value),maxTokens:Number(field('#dsh-output').value)})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'保存失败');
      field('#dsh-api-key').value='';field('#dsh-search-key').value='';applyPatch({dsh_provider:data.provider,model:data.model});
      const provider=host.querySelector('#dsh-provider'),model=host.querySelector('#dsh-model-id');if(provider)provider.value=data.provider;if(model)model.value=data.model;
      status.textContent=data.message;
    }catch(e){status.textContent=e.message;}finally{field('#dsh-save-connection').disabled=false;}
  });
}
