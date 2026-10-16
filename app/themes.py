"""Read-only wallpaper catalog and project assets for the theme engine."""
import hashlib
import hmac
import secrets
import time
import json
import mimetypes
import re
from urllib.parse import quote
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from theme_engine import Library, ImportFailure
from . import config

router = APIRouter(prefix='/api/themes')
asset_router = APIRouter(prefix='/api/themes')
asset_key = secrets.token_bytes(32)


def get_library():
    # Optional wallpaper storage must not prevent the panel from starting.
    # Retry on each request so repairing the directory needs no process restart.
    try:
        return Library(config.DATA_DIR / 'themes' / 'library')
    except OSError as exc:
        raise HTTPException(503, '壁纸库暂时不可用，请稍后重试') from exc


def asset_url(identity, name):
    expiry = str(int(time.time()) + 86400)
    signature = hmac.new(asset_key,f'{identity}:{expiry}'.encode(),hashlib.sha256).hexdigest()
    return f'/api/themes/assets/{identity}/{expiry}-{signature}/' + quote(name, safe='/') if name else None


@router.get('/catalog')
def catalog():
    try:
        result = get_library().catalog()
    except OSError as exc:
        raise HTTPException(503, '壁纸库暂时不可用，请稍后重试') from exc
    for item in result['items']:
        item['source'] = asset_url(item['id'], item.pop('file', None))
        item['preview'] = asset_url(item['id'], item.get('preview'))
    return result


@asset_router.get('/assets/{identity}/{ticket}/{name:path}')
def resource(identity: str, ticket: str, name: str, request: Request):
    # A read-only project capability works inside opaque-origin iframes without session cookies.
    expiry, _, signature = ticket.partition('-')
    expected = hmac.new(asset_key,f'{identity}:{expiry}'.encode(),hashlib.sha256).hexdigest()
    if not re.fullmatch(r'[0-9]{10,12}', expiry) or int(expiry) < time.time() or not hmac.compare_digest(signature,expected):
        raise HTTPException(403, '壁纸链接已过期，请刷新壁纸库')
    try:
        library = get_library()
        path = library.asset(identity, name)
        manifest = library.manifest(identity)
    except (ImportFailure, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, '壁纸资源不存在') from exc
    except OSError as exc:
        raise HTTPException(503, '壁纸库暂时不可用，请稍后重试') from exc
    media = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    # Only the immutable imported project directory can supply resources to the sandbox.
    proto = 'https' if (request.url.scheme == 'https' or (config.load().get('trust_proxy') and request.headers.get('x-forwarded-proto') == 'https')) else 'http'
    host = request.headers.get('host', '')
    if not re.fullmatch(r'[A-Za-z0-9.\-:\[\]]+', host):
        raise HTTPException(400, '无效的 Host')
    scope = f'{proto}://{host}/api/themes/assets/{identity}/{ticket}/'
    policy = (
        "default-src 'none'; sandbox allow-scripts; "
        f"script-src {scope} 'unsafe-inline' 'unsafe-eval'; style-src {scope} 'unsafe-inline'; "
        f"img-src {scope} data: blob:; font-src {scope} data:; media-src {scope} blob:; "
        f"connect-src {scope}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    )
    headers = {'Content-Security-Policy': policy, 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'private, max-age=86400', 'Access-Control-Allow-Origin': '*'}
    if request.headers.get('origin') == 'null':
        headers['Access-Control-Allow-Origin'] = 'null'
        headers['Access-Control-Allow-Credentials'] = 'true'
        headers['Vary'] = 'Origin'
    if path.suffix.lower() in {'.html', '.htm'}:
        properties = json.dumps(manifest.get('properties', {}), ensure_ascii=True).replace('<', '\\u003c')
        bridge = '''<script>(function(){'use strict';const properties=PROPERTIES,scope=SCOPE;let listener;
const local=url=>{try{return new URL(url,location.href).href.startsWith(scope);}catch(e){return false;}};
const originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){const result=originalOpen.call(this,method,url,...args);this.__cyanLocal=local(url);if(this.__cyanLocal)this.withCredentials=true;return result;};
const originalHeader=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(name,value){if(this.__cyanLocal&&!['accept','accept-language','content-language'].includes(name.toLowerCase()))return;return originalHeader.call(this,name,value);};
const originalFetch=window.fetch;window.fetch=function(input,options){return originalFetch.call(this,input,local(typeof input==='string'?input:input.url)?{...options,credentials:'include'}:options);};
Object.defineProperty(window,'wallpaperPropertyListener',{configurable:true,get:()=>listener,set(value){listener=value;queueMicrotask(()=>{try{listener?.applyUserProperties?.(properties);listener?.applyGeneralProperties?.({fps:30});}catch(e){}});}});
window.wallpaperRegisterAudioListener=function(callback){if(typeof callback==='function')callback(new Array(128).fill(0));};
window.wallpaperRegisterMediaPropertiesListener=function(){};
window.wallpaperRegisterMediaPlaybackListener=function(){};
window.wallpaperRegisterMediaTimelineListener=function(){};
window.wallpaperRequestRandomFileForProperty=function(property,callback){if(typeof callback==='function')callback(property,'');};
window.wallpaperRegisterDirectoryFilesListener=function(property,callback){if(typeof callback==='function')callback(property,[]);};
window.wallpaperRegisterDirectoryFilesAddedOrChangedListener=function(){};
window.wallpaperRegisterDirectoryFilesRemovedListener=function(){};
for(const key of ['AudioContext','webkitAudioContext']){const Native=window[key];if(Native)window[key]=class extends Native{constructor(...args){super(...args);this.suspend();this.resume=()=>Promise.resolve();}};}
document.addEventListener('DOMContentLoaded',()=>{try{listener?.applyUserProperties?.(properties);}catch(e){}});
const mute=()=>document.querySelectorAll('video,audio').forEach(el=>{if(!el.muted)el.muted=true;if(el.volume!==0)el.volume=0;});new MutationObserver(mute).observe(document,{childList:true,subtree:true});document.addEventListener('play',mute,true);document.addEventListener('volumechange',mute,true);
})();</script>'''
        bridge = re.sub(r'\b(PROPERTIES|SCOPE)\b', lambda m: {'PROPERTIES': properties, 'SCOPE': json.dumps(scope)}[m[0]], bridge)
        html = path.read_text(encoding='utf-8-sig', errors='replace')
        # Insert before project scripts while keeping a standards-mode doctype.
        match = re.search(r'<head\b[^>]*>', html, re.I)
        if match:
            html = html[:match.end()] + bridge + html[match.end():]
        else:
            match = re.match(r'\s*<!doctype[^>]*>', html, re.I)
            at = match.end() if match else 0
            html = html[:at] + bridge + html[at:]
        headers['Cache-Control'] = 'private, no-cache'
        return Response(html, media_type='text/html', headers=headers)
    return FileResponse(path, media_type=media, headers=headers)
