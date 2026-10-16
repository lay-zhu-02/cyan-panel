/* Optional settings UI. Inject a catalog loader; no framework or API dependency. */
(function(global){
  'use strict';
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const closeIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
  class CyanThemeSettings {
    constructor(engine,{trigger,loadCatalog,title='主题与壁纸'}={}){
      this.engine=engine;this.trigger=trigger;this.loadCatalog=loadCatalog;this.loaded=false;
      this.dialog=el('dialog','ct-settings');this.dialog.setAttribute('aria-labelledby','ct-settings-title');
      this.dialog.innerHTML=`<header class="ct-settings-head"><div><h2 id="ct-settings-title">主题与壁纸</h2></div><button type="button" class="ct-close" aria-label="关闭主题设置">${closeIcon}</button></header>
<div class="ct-settings-body">
<section class="ct-section" aria-labelledby="ct-mode-title"><div class="ct-section-head"><h3 id="ct-mode-title">外观</h3><button type="button" class="ct-text-button" data-action="reset">恢复默认</button></div><fieldset class="ct-mode"><legend class="ct-sr-only">明暗模式</legend><label><input type="radio" name="ct-mode" value="light"><span>明亮</span></label><label><input type="radio" name="ct-mode" value="dark"><span>深色</span></label><label><input type="radio" name="ct-mode" value="auto"><span>跟随系统</span></label></fieldset>
<div class="ct-control-head"><label for="ct-accent">主题配色</label><label class="ct-custom-color"><input type="color" id="ct-accent" aria-label="自定义主题色"><span>自定义</span></label></div><div class="ct-palettes" aria-label="预设主题配色"></div>
<label class="ct-range-label" for="ct-transparency"><span>界面透明度</span><output id="ct-transparency-value"></output></label><input id="ct-transparency" type="range" min="0" max="100" step="1"></section>
<section class="ct-section" aria-labelledby="ct-wallpaper-title"><div class="ct-section-head"><h3 id="ct-wallpaper-title">背景壁纸</h3></div><div class="ct-background-controls"><label class="ct-select-label" for="ct-motion">动态播放<select id="ct-motion"><option value="auto">自动</option><option value="on">播放</option><option value="off">暂停</option></select></label><label class="ct-range-label" for="ct-background-transparency"><span>背景透明度</span><output id="ct-background-transparency-value"></output></label><input id="ct-background-transparency" type="range" min="0" max="100" step="1"></div>
<p class="ct-library-summary" role="status"></p><div class="ct-gallery" aria-label="壁纸项目"></div></section>
</div><footer class="ct-settings-foot"><p class="ct-feedback" role="status" aria-live="polite">更改自动保存</p><button type="button" class="ct-done">完成</button></footer>`;
      this.dialog.querySelector('#ct-settings-title').textContent=title;this.dialog.querySelector('.ct-close').setAttribute('aria-label','关闭'+title);document.body.append(this.dialog);
      const find=selector=>this.dialog.querySelector(selector);this.find=find;
      for(const palette of CyanTheme.palettes){const button=el('button','ct-palette');button.type='button';button.dataset.color=palette.color;button.setAttribute('aria-label',palette.name);const swatches=el('span','ct-palette-swatches');swatches.setAttribute('aria-hidden','true');for(const color of palette.colors){const dot=el('i');dot.style.background=color;swatches.append(dot);}button.append(swatches,el('span','',palette.name));button.onclick=()=>engine.update({accent:palette.color});find('.ct-palettes').append(button);}
      this.openHandler=()=>this.open();trigger?.addEventListener('click',this.openHandler);
      find('.ct-close').onclick=()=>this.dialog.close();find('.ct-done').onclick=()=>this.dialog.close();
      this.dialog.addEventListener('click',event=>{if(event.target===this.dialog&&event.clientX<this.dialog.getBoundingClientRect().left)this.dialog.close();});
      this.dialog.addEventListener('close',()=>this.returnFocus?.isConnected&&this.returnFocus.focus());
      this.dialog.querySelectorAll('[name=ct-mode]').forEach(input=>input.onchange=()=>engine.update({mode:input.value}));
      for(const [id,key] of [['ct-accent','accent'],['ct-transparency','transparency'],['ct-background-transparency','backgroundTransparency']])find('#'+id).oninput=event=>engine.update({[key]:key==='accent'?event.target.value:Number(event.target.value)});
      find('#ct-motion').onchange=event=>engine.update({motion:event.target.value});
      find('[data-action=reset]').onclick=()=>{engine.reset();this.feedback('已恢复默认主题。');};
      this.onChange=()=>this.sync();this.onCatalog=()=>this.renderGallery();this.onWarning=event=>this.feedback(event.detail,true);engine.addEventListener('change',this.onChange);engine.addEventListener('catalog',this.onCatalog);engine.addEventListener('warning',this.onWarning);this.sync();
    }
    feedback(text,error=false){const node=this.find('.ct-feedback');node.textContent=text;node.classList.toggle('ct-error',error);}
    sync(){const state=this.engine.settings;this.dialog.querySelectorAll('[name=ct-mode]').forEach(input=>input.checked=input.value===state.mode);this.find('#ct-accent').value=state.accent;for(const [name,key] of [['transparency','transparency'],['background-transparency','backgroundTransparency']]){this.find('#ct-'+name).value=state[key];this.find('#ct-'+name+'-value').textContent=state[key]+'%';}this.find('#ct-motion').value=state.motion;this.dialog.querySelectorAll('[data-color]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.color===state.accent)));this.dialog.querySelectorAll('[data-wallpaper]').forEach(button=>button.setAttribute('aria-pressed',String((button.dataset.wallpaper||null)===state.wallpaperId)));}
    async refresh(){try{const catalog=await this.loadCatalog?.();if(catalog)this.engine.setCatalog(catalog.items||[]);this.loaded=true;this.renderGallery();}catch(error){this.feedback('壁纸暂时无法加载，重新打开后重试。',true);}}
    async open(){this.returnFocus=document.activeElement;this.dialog.showModal();this.sync();if(!this.loaded)await this.refresh();}
    renderGallery(){const all=this.engine.catalog;this.find('.ct-library-summary').textContent=`${all.length} 张壁纸`;
      const fragment=document.createDocumentFragment();
      for(const item of [{id:'',title:'不使用壁纸',kind:'none',render:'none'},...all]){const button=el('button','ct-project');button.type='button';button.dataset.wallpaper=item.id;button.disabled=item.kind!=='none'&&!item.source;button.setAttribute('aria-pressed',String((item.id||null)===this.engine.settings.wallpaperId));button.title=item.title;
        const cover=el('div','ct-project-cover');if(item.kind==='none'){cover.classList.add('ct-none-cover');const mark=el('span','ct-none-mark','无壁纸');mark.setAttribute('aria-hidden','true');cover.append(mark);}else if(item.preview){const image=el('img');image.src=item.preview;image.alt='';image.loading='lazy';image.onerror=()=>image.remove();cover.append(image);}else cover.append(el('span','ct-cover-placeholder','无封面'));
        const label=item.kind==='none'?'纯色':item.kind==='scene'?'静态封面':item.render==='video'?'视频':item.render==='web'?'动态':'不支持';cover.append(el('span','ct-project-type',label));button.append(cover,el('strong','ct-project-title',item.title));button.onclick=()=>{this.engine.update({wallpaperId:item.id||null});this.feedback(item.kind==='none'?'已关闭壁纸':'壁纸已应用');};fragment.append(button);}
      if(!all.length)fragment.append(el('p','ct-empty','暂无壁纸'));this.find('.ct-gallery').replaceChildren(fragment);
    }
    destroy(){this.trigger?.removeEventListener('click',this.openHandler);this.engine.removeEventListener('change',this.onChange);this.engine.removeEventListener('catalog',this.onCatalog);this.engine.removeEventListener('warning',this.onWarning);if(this.dialog.open)this.dialog.close();this.dialog.remove();}
  }
  global.CyanThemeSettings=CyanThemeSettings;
})(window);
