(function(){
  var main=document.querySelector('main'); if(!main||document.getElementById('fs-guide-cta'))return;
  var h1=main.querySelector('h1'); if(!h1)return;
  var anchor=h1; var el=h1.nextElementSibling, n=0;
  while(el&&n<4){ if(el.tagName==='P'&&!el.classList.contains('meta')&&el.textContent.length>80){anchor=el;break;} el=el.nextElementSibling; n++; }
  var path=location.pathname.replace(/^\//,'')||'home';
  var ev=/ev|electric|charg/i.test(path);
  var txt=ev?'Work out what an EV would really cost you':'Get the exact running cost for your own car';
  var pr=/^(fuel-prices|uk|us|france|germany|australia)$/.test(path);
  if(pr){txt='Turn these prices into your journey cost';}
  var sub=ev?'Enter your journey and compare petrol, diesel and electric in seconds.':pr?'Enter your route and car — we’ll work out exactly what the trip costs.':'Enter your car and journey — we’ll show the real fuel cost, free.';
  var a=document.createElement('a'); a.id='fs-guide-cta'; a.href=ev?'/ev-calculator':'/';
  a.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;margin:1.25rem 0;padding:14px 16px;border-radius:12px;background:var(--card,#fff);border:1px solid var(--accent,#2D6A4F);color:inherit;';
  a.innerHTML='<span><strong style="display:block;font-size:15px;">'+txt+'</strong><span style="font-size:13px;opacity:.75;">'+sub+'</span></span><span style="background:var(--accent,#2D6A4F);color:#fff;border-radius:8px;padding:9px 14px;font-weight:700;font-size:14px;white-space:nowrap;">Calculate →</span>';
  a.addEventListener('click',function(){try{if(window.gtag)gtag('event','calculator_cta_click',{page:path,position:'top'});}catch(e){}});
  anchor.parentNode.insertBefore(a,anchor.nextSibling);
  document.querySelectorAll('main a.cta').forEach(function(b){b.addEventListener('click',function(){try{if(window.gtag)gtag('event','calculator_cta_click',{page:path,position:'bottom'});}catch(e){}});});
})();
