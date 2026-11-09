// Replaces the static UK petrol/diesel figures on the page with the live national average, when available.
(function(){
  fetch('/api/uk-prices').then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d||!d.live)return;
    function fill(sel,v){document.querySelectorAll(sel).forEach(function(el){var f=el.getAttribute('data-fmt')||'p';el.textContent=v.toFixed(1)+(f==='pL'?'p/L':f==='plitre'?'p/litre':'p');});}
    fill('[data-uk-petrol]',d.petrol); fill('[data-uk-diesel]',d.diesel);
    document.querySelectorAll('[data-uk-updated]').forEach(function(el){el.textContent='Live UK average, updated '+d.updated;});
  }).catch(function(){});
})();
