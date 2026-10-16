/* The only panel-specific adapter. The vendor package knows nothing about panel APIs. */
(function(){
  'use strict';
  const engine=new CyanTheme({storageKey:'cyan-panel.appearance.v1'});
  let settings,loading,generation=0;
  async function catalog(){const response=await fetch('/api/themes/catalog',{credentials:'same-origin'});const data=await response.json();if(!response.ok)throw new Error(data.detail||'无法读取壁纸库');return data;}
  engine.addEventListener('change',event=>{document.querySelector('meta[name=theme-color]')?.setAttribute('content',getComputedStyle(document.documentElement).getPropertyValue('--ct-base').trim());document.dispatchEvent(new CustomEvent('cyan-theme:change',{detail:event.detail}));});
  window.panelAppearance={engine,
    async start(){if(!settings){settings=new CyanThemeSettings(engine,{trigger:document.querySelector('#btn-settings'),loadCatalog:catalog,title:'设置'});}engine.start();if(loading)return loading;const epoch=generation;loading=catalog().then(data=>{if(epoch!==generation)return;engine.setCatalog(data.items);settings.loaded=true;}).catch(error=>settings.feedback('壁纸暂时无法加载，重新打开后重试。',true)).finally(()=>{loading=null;});return loading;},
    suspend(){generation++;engine.suspend();if(settings?.dialog.open)settings.dialog.close();},
    get settings(){return settings;},
  };
})();
