/* Cyan Theme v1 — framework independent; no panel routes, credentials or selectors. */
(function (global) {
  'use strict';
  const defaults = Object.freeze({mode:'dark',accent:'#67e8f9',transparency:18,backgroundTransparency:65,wallpaperId:null,motion:'auto'});
  const palettes = Object.freeze([
    {name:'冰川青',color:'#67e8f9',colors:['#67e8f9','#a5b4fc','#5eead4','#93c5fd']},
    {name:'海洋蓝',color:'#60a5fa',colors:['#60a5fa','#67e8f9','#c4b5fd','#5eead4']},
    {name:'鸢尾紫',color:'#a78bfa',colors:['#a78bfa','#f0abfc','#93c5fd','#c4b5fd']},
    {name:'翡翠绿',color:'#34d399',colors:['#34d399','#67e8f9','#bef264','#5eead4']},
    {name:'落日橙',color:'#fb923c',colors:['#fb923c','#fcd34d','#fda4af','#fdba74']},
    {name:'蔷薇粉',color:'#f472b6',colors:['#f472b6','#c4b5fd','#fdba74','#f0abfc']},
  ]);
  const finite = (v,min,max,fallback) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max,Math.max(min,v)) : fallback;
  function normalize(input = {}) {
    return {
      mode:['dark','light','auto'].includes(input.mode) ? input.mode : defaults.mode,
      accent:typeof input.accent === 'string' && /^#[\da-f]{6}$/i.test(input.accent) ? input.accent.toLowerCase() : defaults.accent,
      transparency:finite(input.transparency,0,100,defaults.transparency),
      // Read the previous key once so existing browser preferences keep their value.
      backgroundTransparency:finite(input.backgroundTransparency??input.wallpaperOpacity,0,100,defaults.backgroundTransparency),
      wallpaperId:typeof input.wallpaperId === 'string' && /^[\w-]{1,100}$/.test(input.wallpaperId) ? input.wallpaperId : null,
      motion:['auto','on','off'].includes(input.motion) ? input.motion : defaults.motion,
    };
  }
  const rgb = color => color.slice(1).match(/../g).map(v=>parseInt(v,16));
  function luminance(color) { return rgb(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0); }
  function contrast(a,b) { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
  const hex = values => '#'+values.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
  function accessibleAccent(color,mode) {
    const bg=mode==='light'?'#c6c8ca':'#42464c',target=mode==='light'?[0,0,0]:[255,255,255],values=rgb(color);
    for(let i=0;i<=100;i++) { const result=hex(values.map((v,j)=>v+(target[j]-v)*i/100));if(contrast(result,bg)>=4.5)return result; }
    return mode==='light'?'#172334':'#e8eef5';
  }
  function hue(color) {
    const [r,g,b]=rgb(color).map(v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
    if(d<.01)return 210;
    return ((max===r?(g-b)/d:max===g?(b-r)/d+2:(r-g)/d+4)*60+360)%360;
  }
  function hueColor(h) {
    const s=.65,l=.68,a=s*Math.min(l,1-l);
    return hex([0,8,4].map(n=>{const k=(n+h/30)%12;return 255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)));}));
  }
  function themePalette(color,mode) {
    const preset=palettes.find(p=>p.color===color),h=hue(color);
    const colors=preset?.colors||[color,hueColor((h+48)%360),hueColor((h+325)%360),hueColor((h+85)%360)];
    return colors.map(c=>accessibleAccent(c,mode));
  }
  const tint=(base,color,amount)=>hex(rgb(base).map((v,i)=>v+(rgb(color)[i]-v)*amount));
  class CyanTheme extends EventTarget {
    static defaults = defaults;
    static palettes = palettes;
    static palette = themePalette;
    static normalize = normalize;
    static contrast = contrast;
    constructor({root=document.documentElement,storageKey='cyan-theme.v1',allowedOrigins=[location.origin]}={}) {
      super();this.root=root;this.storageKey=storageKey;this.allowedOrigins=allowedOrigins;this.catalog=[];this.background=null;this.renderKey=null;this.active=false;this.destroyed=false;
      this.dark=matchMedia('(prefers-color-scheme: dark)');this.reduced=matchMedia('(prefers-reduced-motion: reduce)');
      let saved;try{saved=storageKey?JSON.parse(localStorage.getItem(storageKey)):null;}catch(_){}
      this.settings=normalize(saved?.schema==='cyan-theme/v1'?saved.settings:defaults);
      this.onMedia=()=>this.apply();this.onVisibility=()=>this.renderWallpaper();
      this.onStorage=event=>{if(event.key===this.storageKey){try{const value=JSON.parse(event.newValue);this.settings=normalize(value?.schema==='cyan-theme/v1'?value.settings:defaults);this.apply();}catch(_){}}};
      this.dark.addEventListener('change',this.onMedia);this.reduced.addEventListener('change',this.onMedia);document.addEventListener('visibilitychange',this.onVisibility);window.addEventListener('storage',this.onStorage);this.apply();
    }
    get mode() {return this.settings.mode==='auto'?(this.dark.matches?'dark':'light'):this.settings.mode;}
    get paused() {return this.settings.motion==='off'||(this.settings.motion==='auto'&&this.reduced.matches)||document.hidden||this.settings.backgroundTransparency===0;}
    update(patch) {
      this.settings=normalize({...this.settings,...patch});
      try{if(this.storageKey)localStorage.setItem(this.storageKey,JSON.stringify({schema:'cyan-theme/v1',settings:this.settings}));}catch(_){this.dispatchEvent(new CustomEvent('warning',{detail:'浏览器未允许保存，当前设置仍已生效。'}));}
      this.apply();return {...this.settings};
    }
    reset() {return this.update(defaults);}
    url(value) {
      if(!value)return null;
      try{const url=new URL(value,location.href);return /^https?:$/.test(url.protocol)&&this.allowedOrigins.includes(url.origin)?url.href:null;}catch(_){return null;}
    }
    setCatalog(items) {
      const previous=this.catalog.find(item=>item.id===this.settings.wallpaperId)?.source;
      this.catalog=Array.isArray(items)?items.filter(item=>item&&typeof item.id==='string').map(item=>({...item,source:this.url(item.source),preview:this.url(item.preview)})):[];
      if(previous!==this.catalog.find(item=>item.id===this.settings.wallpaperId)?.source)this.clearWallpaper();
      this.renderWallpaper();this.dispatchEvent(new CustomEvent('catalog',{detail:this.catalog}));
    }
    start() {
      this.active=true;
      if(!this.background){this.background=document.createElement('div');this.background.className='ct-wallpaper';this.background.setAttribute('aria-hidden','true');this.background.inert=true;document.body.prepend(this.background);}
      this.renderWallpaper();
    }
    suspend() {this.active=false;this.clearWallpaper();}
    clearWallpaper() {
      const video=this.background?.querySelector('video');if(video){video.pause();video.removeAttribute('src');video.load();}
      this.background?.replaceChildren();this.renderKey=null;
    }
    apply() {
      const light=this.mode==='light',s=this.settings,accent=accessibleAccent(s.accent,this.mode),color=rgb(s.accent).join(',');
      this.root.dataset.ctMode=this.mode;
      this.root.style.colorScheme=this.mode;
      const baseColor=tint(light?'#f6f7f9':'#0f1115',s.accent,light?.025:.035),panelColor=tint(light?'#ffffff':'#171a20',s.accent,light?.012:.025);
      const base=rgb(baseColor).join(','),panel=rgb(panelColor).join(','),raised=rgb(tint(light?'#eef0f4':'#1f232b',s.accent,.04)).join(',');
      const [primary,secondary,tertiary,quaternary]=themePalette(s.accent,this.mode);
      const opacity=1-s.transparency/100;
      // Keep solid glyphs and distinct text levels; never outline or glow the content.
      const readability=s.wallpaperId?Math.min(1,Math.max(0,(s.transparency/100*s.backgroundTransparency/100-.12)/.28)):0;
      const foreground=tint(light?'#172334':'#e8eef5',light?'#000000':'#ffffff',readability);
      const muted=tint(light?'#435267':'#a6b7c9',light?'#263244':'#d8e2ed',readability);
      const vars={
        '--ct-base':`rgb(${base})`,'--ct-surface':`rgba(${panel},${1-s.transparency/100})`,'--ct-shell':`rgba(${base},${opacity})`,
        '--ct-raised':`rgba(${raised},${opacity})`,'--ct-blur':`${18*opacity}px`,'--ct-input':panelColor,'--ct-fg':foreground,
        '--ct-muted':muted,
        '--ct-text-shadow':!light&&readability>0?`0 1px 2px rgba(0,0,0,${Number((readability*.18).toFixed(3))})`:'none',
        '--ct-line':tint(light?'#d7dce3':'#303843',s.accent,.08),'--ct-accent':accent,'--ct-accent-solid':s.accent,
        '--ct-on-accent':contrast(s.accent,'#09252d')>=contrast(s.accent,'#ffffff')?'#09252d':'#ffffff','--ct-accent-soft':`rgba(${color},${light?.16:.14})`,
        '--ct-hover':tint(light?'#edf0f5':'#252c36',s.accent,.06),'--ct-selected':tint(light?'#e3e9f1':'#303b49',s.accent,.10),'--ct-danger':light?'#9c1e32':'#ff9b9b',
        '--ct-success':light?'#125b3e':'#6ee7b7','--ct-warning':light?'#704600':'#fcd29a','--ct-scrim':`rgba(${base},${1-s.backgroundTransparency/100})`,
        '--ct-folder':light?'#886013':'#e9bd76','--ct-secondary':secondary,
        '--ct-chart-cpu':primary,'--ct-chart-memory':secondary,'--ct-chart-rx':primary,'--ct-chart-tx':secondary,
        '--ct-chart-read':tertiary,'--ct-chart-write':quaternary,'--ct-chart-load':quaternary,
        '--ct-code':quaternary,'--ct-overlay':light?'#1723345c':'#060b1390',
      };
      Object.entries(vars).forEach(([name,value])=>this.root.style.setProperty(name,value));
      this.renderWallpaper();this.dispatchEvent(new CustomEvent('change',{detail:{settings:{...s},mode:this.mode}}));
    }
    reveal(node) {
      // Start from a painted transparent frame, including when media comes from cache.
      requestAnimationFrame(()=>{if(node.isConnected)requestAnimationFrame(()=>{if(node.isConnected)node.dataset.ctReady='true';});});
    }
    image(source,freeze=false) {
      const img=document.createElement('img');img.alt='';img.className='ct-cover';img.draggable=false;
      img.onerror=()=>this.dispatchEvent(new CustomEvent('warning',{detail:'壁纸图片读取失败，请刷新壁纸库或选择其他项目。'}));
      img.onload=()=>{
        if(!img.isConnected||!img.naturalWidth)return;
        if(freeze){const canvas=document.createElement('canvas');canvas.width=Math.min(2560,img.naturalWidth);canvas.height=Math.round(img.naturalHeight*canvas.width/img.naturalWidth);canvas.className='ct-cover';canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);img.replaceWith(canvas);this.reveal(canvas);}
        else this.reveal(img);
      };
      img.src=source;
      return img;
    }
    renderWallpaper() {
      if(!this.active||!this.background)return;
      const project=this.catalog.find(item=>item.id===this.settings.wallpaperId);
      if(!project?.source){this.clearWallpaper();return;}
      const video=this.background.querySelector('video');
      if(project.render==='video'&&video&&this.renderKey===project.id+':video'){
        if(this.paused)video.pause();else video.play().catch(()=>this.dispatchEvent(new CustomEvent('warning',{detail:'浏览器未能播放此视频，可选择封面或其他项目。'})));return;
      }
      const render=(this.paused&&['web','video'].includes(project.render))?'poster':project.render;
      const key=project.id+':'+render+':'+(render==='image'?this.paused:'');if(this.renderKey===key)return;
      this.clearWallpaper();let node;
      if(render==='video'){
        node=document.createElement('video');node.className='ct-cover';node.muted=true;node.defaultMuted=true;node.autoplay=true;node.loop=true;node.playsInline=true;node.preload='metadata';node.disablePictureInPicture=true;
        // Gallery thumbnails may be square crops. Wait for the real frame instead
        // of showing a differently framed poster while the video loads.
        const ready=()=>this.reveal(node);
        if(node.requestVideoFrameCallback)node.requestVideoFrameCallback(ready);
        else node.addEventListener('loadeddata',ready,{once:true});
        node.src=project.source;node.onerror=()=>{
          if(!node.isConnected)return;
          if(project.preview)node.replaceWith(this.image(project.preview,this.paused));
          this.dispatchEvent(new CustomEvent('warning',{detail:project.preview?'此视频无法解码，已显示封面。请更换兼容的视频项目。':'此视频无法解码，请更换兼容的视频项目。'}));
        };
      }else if(render==='web'){
        node=document.createElement('iframe');node.className='ct-web';node.sandbox='allow-scripts';node.referrerPolicy='no-referrer';node.setAttribute('allow',"autoplay *; microphone 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'");node.title=project.title||'壁纸';node.tabIndex=-1;node.inert=true;node.src=project.source;
        node.addEventListener('load',()=>this.reveal(node),{once:true});
      }else if(render==='image'||render==='poster'){
        const source=render==='poster'?project.preview:project.source;if(source)node=this.image(source,this.paused);
      }
      if(node)this.background.append(node);this.renderKey=render==='video'?project.id+':video':key;
    }
    destroy() {this.suspend();this.background?.remove();this.dark.removeEventListener('change',this.onMedia);this.reduced.removeEventListener('change',this.onMedia);document.removeEventListener('visibilitychange',this.onVisibility);window.removeEventListener('storage',this.onStorage);this.destroyed=true;}
  }
  global.CyanTheme=CyanTheme;
})(window);
