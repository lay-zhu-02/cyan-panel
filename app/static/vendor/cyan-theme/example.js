'use strict';
const exampleTheme=new CyanTheme({storageKey:'cyan-theme.example.v1'});
exampleTheme.start();
const exampleSettings=new CyanThemeSettings(exampleTheme,{trigger:document.querySelector('#appearance'),loadCatalog:async()=>({schema:1,items:[]})});
window.themeExample={engine:exampleTheme,settings:exampleSettings};
