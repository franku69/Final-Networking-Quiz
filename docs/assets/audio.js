/* Packet Quest v6 synthesized 8-bit BGM. Explicit opt-in keeps Google Meet/class audio usable. */
(function(){'use strict';
  var context=null, enabled=false, timer=null, step=0, master=null;
  var melody=[329.63,392.00,493.88,392.00,349.23,440.00,523.25,440.00,293.66,369.99,440.00,369.99,261.63,329.63,392.00,329.63];
  var bass=[82.41,82.41,98.00,98.00,73.42,73.42,65.41,65.41];
  function ensure(){
    var AC=window.AudioContext||window.webkitAudioContext;
    if(!AC) throw Error('This browser does not support the optional BGM.');
    if(!context){ context=new AC(); master=context.createGain(); master.gain.value=0.12; master.connect(context.destination); }
    return context;
  }
  function voice(freq,duration,volume,type,delay){
    if(!context||context.state!=='running')return;
    var osc=context.createOscillator(), gain=context.createGain(), t=context.currentTime+(delay||0);
    osc.type=type||'square'; osc.frequency.setValueAtTime(freq,t);
    gain.gain.setValueAtTime(0.0001,t); gain.gain.exponentialRampToValueAtTime(volume,t+0.018); gain.gain.exponentialRampToValueAtTime(0.0001,t+duration);
    osc.connect(gain); gain.connect(master); osc.start(t); osc.stop(t+duration+0.03);
    osc.onended=function(){try{osc.disconnect();gain.disconnect();}catch(e){}};
  }
  function loop(){
    clearTimeout(timer); if(!enabled||document.hidden)return;
    var i=step++;
    voice(melody[i%melody.length],0.18,0.085,'square',0);
    if(i%2===0) voice(bass[Math.floor(i/2)%bass.length],0.34,0.065,'triangle',0);
    if(i%4===3) voice(659.25,0.055,0.025,'square',0.18);
    timer=setTimeout(loop,285);
  }
  async function setEnabled(on){
    enabled=!!on;
    if(enabled){ ensure(); await context.resume(); loop(); }
    else { clearTimeout(timer); if(context) await context.suspend(); }
    return enabled;
  }
  async function toggle(){return setEnabled(!enabled);}
  function sfx(freq,dur,vol){if(enabled)voice(freq,dur,vol||0.10,'square',0);}
  document.addEventListener('visibilitychange',function(){
    clearTimeout(timer); if(!context)return;
    if(document.hidden) context.suspend().catch(function(){});
    else if(enabled) context.resume().then(loop).catch(function(){});
  });
  window.PacketAudio={toggle:toggle,enable:function(){return setEnabled(true);},isEnabled:function(){return enabled;},select:function(){sfx(587.33,0.055,0.07);},finish:function(){if(enabled){voice(523.25,0.13,0.11,'square',0);voice(659.25,0.13,0.10,'square',0.12);voice(783.99,0.26,0.10,'square',0.24);}}};
}());
