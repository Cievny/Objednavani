// Dotazník pred vyšetrením — chronická panvová bolesť (dotaznik-001, v139).
// Otázky, rozcestník (úvodné otázky skrývajú nepotrebné bloky), vyhodnotenie
// podľa kľúča pre lekára a text anamnézy do správy. Čisté funkcie bez DOM —
// používa ich formulár pre pacientku (src/dotaznik.jsx) aj náhľad lekára v správe.
// Pôvod: dotazník „Panvové venózne poruchy" (pracovná verzia 11/2026, časť A a B).
// Dotazník NIE JE validovaný diagnostický test a nemá skóre ani prah.
import { supabase } from "./supabaseClient.js";

const Y=new Date().getFullYear();
const NO=['nie','áno'],NOU=['nie','áno','neviem'];
export const Q=[
{s:'Na úvod',d:'Podľa týchto odpovedí Vám ďalej ukážeme len otázky, ktoré sa Vás týkajú.'},
{id:'q20',g:1,t:'Máte ešte menštruáciu?',k:'one',o:['áno, pravidelnú','áno, nepravidelnú','nie, pre hormonálnu liečbu','nie, som po prechode']},
{id:'gt',g:1,t:'Boli ste niekedy tehotná?',k:'one',o:NO},
{id:'gs',g:1,t:'Máte bolesť pri pohlavnom styku alebo po ňom?',k:'one',o:['nie','áno','pohlavný styk nemám pre bolesť','pohlavný styk nemám z iného dôvodu']},
{id:'gv',g:1,t:'Máte alebo ste mali kŕčové žily kdekoľvek (nohy, rodidlá, zadok, slabiny)?',k:'one',o:NO},
{id:'gu',g:1,t:'Máte ťažkosti s močením alebo Vám niekedy zistili krv v moči?',k:'one',o:NO},
{id:'gl',g:1,t:'Liečili Vás už pre tieto bolesti (lieky, fyzioterapia, zákrok)?',k:'one',o:NO},
{s:'Bolesť'},
{id:'q1',n:1,t:'Ako dlho máte bolesti v podbrušku alebo v panve?',k:'one',o:['menej ako 3 mesiace','3–6 mesiacov','6–12 mesiacov','1–5 rokov','viac ako 5 rokov']},
{id:'q2',n:2,t:'Kde bolesť cítite?',m:1,k:'many',o:['podbruško vľavo','podbruško vpravo','uprostred nad lonovou kosťou','kríže a krížová kosť','ľavý bok pod rebrami','pravý bok pod rebrami','pošva alebo hrádza','konečník','zadok','stehno']},
{id:'q2s',t:'Ktoré stehno?',k:'text',sh:()=>has('q2',9)},
{id:'q3',n:3,t:'Aká silná je bolesť?',h:'0 = žiadna, 10 = najhoršia predstaviteľná',rs:{3:()=>!(is('q20',2)||is('q20',3)),4:()=>is('gs',1),5:()=>is('gs',1)},k:'scale',r:['Priemerná bolesť za posledný týždeň','Najhoršia bolesť za posledný týždeň','Bolesť pri dlhom státí','Bolesť počas menštruácie','Bolesť počas pohlavného styku','Bolesť po pohlavnom styku'],e:['žiadna','najhoršia']},
{id:'q4',n:4,t:'Ako by ste bolesť opísali?',m:1,k:'many',o:['tupá, pocit ťažoby alebo tlaku','ostrá, bodavá','kŕčovitá','pálivá alebo ako elektrický výboj']},
{id:'q5',n:5,t:'Kedy bolesť prichádza?',k:'one',o:['je prítomná väčšinu dní','prichádza občas, bez súvisu s menštruáciou','len počas menštruácie alebo tesne pred ňou']},
{id:'q6',n:6,t:'Čo bolesť zhoršuje?',m:1,k:'many',ex:9,o:['dlhé státie','dlhé sedenie','chôdza alebo telesná námaha','koniec dňa (večer je horšia ako ráno)','dni pred menštruáciou','menštruácia','pohlavný styk','plný močový mechúr','stolica','nič z uvedeného']},
{id:'q7',n:7,t:'Čo bolesť zmierňuje?',m:1,k:'many',ex:5,o:['ľah','ľah so zdvihnutými nohami','vymočenie','stolica','lieky proti bolesti','nič']},
{id:'q8',n:8,t:'Ostáva Vám po pohlavnom styku tupá bolesť v podbrušku?',sh:()=>is('gs',1),only:[0,1,2,3],k:'one',o:['nie','áno, do 1 hodiny','áno, niekoľko hodín','áno, do druhého dňa','pohlavný styk nemám pre bolesť','pohlavný styk nemám z iného dôvodu']},
{id:'q9',n:9,t:'Bolesť pri pohlavnom styku cítite:',sh:()=>is('gs',1)||is('gs',2),only:[1,2,3],k:'one',o:['nemám bolesť','hlboko vnútri','pri vchode do pošvy','oboje']},
{id:'q10',n:10,t:'Budí Vás bolesť zo spánku?',k:'one',o:NO},
{s:'Žily a nohy'},
{id:'q11',n:11,t:'Kde máte alebo ste mali kŕčové žily?',m:1,k:'many',ex:6,sh:()=>is('gv',1),only:[0,1,2,3,4,5],o:['vonkajšie pohlavné orgány','hrádza (medzi pošvou a konečníkom)','zadok','zadná alebo vnútorná strana stehna','slabiny alebo podbruško','lýtka a predkolenia','nemám']},
{id:'q11a',t:'Objavili sa v tehotenstve?',k:'one',o:NO,sh:()=>anyOf('q11',[0,1,2,3,4,5])},
{id:'q11b',t:'V ktorom tehotenstve?',k:'text',sh:()=>is('q11a',1)},
{id:'q11c',t:'Zväčšujú sa alebo bolia pred menštruáciou?',k:'one',o:NO,sh:()=>anyOf('q11',[0,1,2,3,4,5])},
{id:'q12',n:12,t:'Mali ste operáciu, laserový zákrok alebo skleroterapiu kŕčových žíl na nohách?',k:'one',o:NO,sh:()=>is('gv',1)},
{id:'q12y',t:'V roku',k:'text',sh:()=>is('q12',1)},
{id:'q12r',t:'Vrátili sa potom žily?',k:'one',o:NO,sh:()=>is('q12',1)},
{id:'q13',n:13,t:'Trápi Vás niečo z tohto?',m:1,k:'many',ex:5,o:['opuch ľavej nohy','opuch pravej nohy','opuch celej nohy až po slabinu','pocit ťažkých nôh','pri chôdzi napätie alebo pocit „prasknutia" v stehne či lýtku, ktorý ustúpi po oddychu so zdvihnutou nohou','nič z uvedeného']},
{id:'q14',n:14,t:'Máte hemoroidy?',k:'one',o:NO},
{id:'q15',n:15,t:'Mali ste Vy alebo Vaši pokrvní príbuzní trombózu žíl alebo pľúcnu embóliu?',m:1,k:'many',ex:0,o:['nie','ja','príbuzní']},
{id:'q15y',t:'V roku a ktorá noha',k:'text',sh:()=>has('q15',1)},
{id:'q15k',t:'Kto z príbuzných?',k:'text',sh:()=>has('q15',2)},
{id:'q15t',t:'Máte zistenú poruchu zrážania krvi (trombofíliu)?',k:'one',o:NOU},
{id:'q15v',t:'Majú kŕčové žily Vaši rodičia alebo súrodenci?',k:'one',o:NO},
{s:'Močenie'},
{id:'q16',n:16,t:'Označte, čo sa Vás týka:',m:1,k:'many',ex:9,sh:()=>is('gu',1),only:[0,1,2,3,4,5,6,7,8],o:['náhle silné nutkanie na močenie, ktoré sa ťažko odkladá','močím cez deň 10-krát alebo častejšie','v noci vstávam močiť','bolesť alebo tlak v mechúre, ktorý sa zhoršuje pri jeho plnení','po vymočení sa bolesť zmierni','pálenie pri močení bez potvrdeného zápalu','únik moču','krv v moči viditeľná okom','krv v moči zistená pri vyšetrení moču','nič z uvedeného']},
{id:'q16n',t:'Koľkokrát v noci?',k:'num',sh:()=>has('q16',2)},
{s:'Trávenie a stolica'},
{id:'q17',n:17,t:'Mali ste za posledné 3 mesiace bolesť brucha aspoň 1 deň v týždni?',k:'one',o:NO},
{id:'q17s',t:'Označte, čo platí:',m:1,k:'many',o:['bolesť súvisí so stolicou (pred ňou sa zhorší alebo po nej poľaví)','zmenilo sa, ako často chodím na stolicu','zmenila sa konzistencia stolice (tvrdšia alebo redšia)'],sh:()=>is('q17',1)},
{id:'q18',n:18,t:'Označte, čo sa Vás týka:',m:1,k:'many',ex:7,o:['nadúvanie','zápcha','hnačka','hnačka, ktorá budí zo spánku','bolesť pri stolici počas menštruácie','krv v stolici','nechcený úbytok hmotnosti','nič z uvedeného']},
{id:'q18f',t:'Mal niekto z pokrvných príbuzných rakovinu hrubého čreva, Crohnovu chorobu, ulceróznu kolitídu alebo celiakiu?',k:'one',o:NO},
{s:'Gynekologické údaje'},
{id:'q19',n:19,t:'Tehotenstvá a pôrody',sh:()=>is('gt',1),k:'fields',f:[['q19g','Počet tehotenstiev'],['q19p','Počet pôrodov'],['q19c','z toho cisárskym rezom'],['q19y','Rok posledného pôrodu']]},
{id:'q19z',t:'Začali alebo zhoršili sa bolesti po niektorom tehotenstve?',k:'one',o:NO,sh:()=>is('gt',1)},
{id:'q19zt',t:'Po ktorom tehotenstve?',k:'text',sh:()=>is('q19z',1)},
{id:'q20m',t:'Posledná menštruácia v roku',k:'num',sh:()=>is('q20',3)},
{id:'q20d',t:'Prvý deň poslednej menštruácie',k:'date',sh:()=>!(is('q20',2)||is('q20',3))},
{id:'q20b',t:'Menštruačné bolesti:',k:'one',o:['žiadne alebo mierne','silné, obmedzujú ma'],sh:()=>!(is('q20',2)||is('q20',3))},
{id:'q20k',t:'Krvácanie:',k:'one',o:['primerané','veľmi silné'],sh:()=>!(is('q20',2)||is('q20',3))},
{id:'q20x',t:'Označte, ak sa vyskytuje:',m:1,k:'many',o:['krvácanie medzi menštruáciami','krvácanie po pohlavnom styku','krvácanie po prechode']},
{id:'q21',n:21,t:'Antikoncepcia alebo hormonálna liečba',m:1,k:'many',ex:5,o:['tabletky','náplasť alebo krúžok','vnútromaternicové teliesko s hormónom','implantát alebo injekcie','hormonálna liečba v prechode','žiadna']},
{id:'q21n',t:'Názov prípravku',k:'text',sh:()=>anyOf('q21',[0,1,2,3,4])},
{id:'q22a',n:22,t:'Je možné, že ste teraz tehotná?',k:'one',o:NOU},
{id:'q22b',t:'Plánujete v budúcnosti tehotenstvo?',k:'one',o:NOU},
{id:'q22c',t:'Mali ste ťažkosti s otehotnením?',k:'one',o:NO},
{id:'q23',n:23,t:'Zistili Vám niekedy:',m:1,k:'many',ex:6,o:['endometriózu','adenomyózu','myómy','cysty na vaječníkoch','zápal v malej panve','rozšírené žily v panve','nič z uvedeného']},
{id:'q23f',t:'Má endometriózu Vaša matka alebo sestra?',k:'one',o:NOU},
{id:'q24',n:24,t:'Operácie brucha a panvy',h:'aké a kedy, vrátane laparoskopie a jej nálezu',k:'long'},
{s:'Iné ochorenia a bolesti'},
{id:'q25',n:25,t:'Lieči Vás lekár pre niektoré z týchto ochorení?',m:1,k:'many',ex:10,o:['syndróm dráždivého čreva','intersticiálna cystitída alebo bolestivý mechúr','fibromyalgia','migréna','chronický únavový syndróm','závraty, búšenie srdca alebo mdloby pri postavení (POTS)','zvýšená pohyblivosť kĺbov alebo Ehlersov-Danlosov syndróm','depresia','úzkostná porucha','dlhodobé bolesti krížov','nič z uvedeného']},
{id:'q26',n:26,t:'Máte bolesť v oblasti hrádze, pošvy alebo konečníka, ktorá je najhoršia pri sedení?',k:'one',o:NO},
{id:'q27',n:27,t:'Máte dlhšie ako 3 mesiace bolesť pri dotyku vchodu do pošvy (tampón, styk, vyšetrenie)?',k:'one',o:NO},
{s:'Nálada'},
{id:'q28',n:28,t:'Ako často Vás za posledné 2 týždne trápili tieto ťažkosti?',k:'phq',r:['Malý záujem alebo potešenie z činností','Pocit skleslosti, depresie alebo beznádeje','Pocit nervozity, úzkosti alebo napätia','Neschopnosť zastaviť alebo ovládať obavy'],o:['Vôbec nie','Niekoľko dní','Viac než polovicu dní','Takmer každý deň']},
{id:'q29',n:29,t:'Niektoré ženy s dlhodobou bolesťou zažili v minulosti násilie alebo zneužívanie. Ak o tom chcete hovoriť, sme pripravení Vás vypočuť.',k:'one',o:['chcem o tom hovoriť pri návšteve','nechcem na túto otázku odpovedať']},
{s:'Doterajšia liečba'},
{id:'q30',n:30,t:'Čo ste už skúšali a ako to pomohlo?',sh:()=>is('gl',1),k:'tx',r:['Lieky proti bolesti (ktoré)','Hormonálna liečba (ktorá)','Lieky na žily, napr. diosmín (ako dlho)','Fyzioterapia panvového dna','Obstreky alebo liečba v ambulancii bolesti','Embolizácia alebo operácia panvových žíl (rok)','Iné'],o:['áno','čiastočne','nie']},
{s:'Údaje dôležité pred výkonom'},
{id:'q31',n:31,t:'Alergie',m:1,k:'many',ex:3,o:['kontrastná látka pri CT alebo angiografii','nikel (vyrážka po bižutérii, gombíkoch, hodinkách)','lieky','žiadne']},
{id:'q31k',t:'Aká bola reakcia na kontrast?',k:'text',sh:()=>has('q31',0)},
{id:'q31l',t:'Na ktoré lieky?',k:'text',sh:()=>has('q31',2)},
{id:'q32',n:32,t:'Užívate lieky na riedenie krvi?',k:'one',o:NO},
{id:'q32t',t:'Ktoré?',k:'text',sh:()=>is('q32',1)},
{id:'q33',n:33,t:'Všetky lieky, ktoré užívate pravidelne',k:'long'},
{s:'Vplyv na život'},
{id:'q34',n:34,t:'Ako veľmi Vás bolesť za posledný mesiac obmedzovala?',h:'0 = vôbec, 10 = úplne',k:'scale',r:['Práca alebo štúdium','Domácnosť a starostlivosť o rodinu','Pohyb a šport','Sexuálny život','Spánok','Nálada'],e:['vôbec','úplne']},
{id:'q35',n:35,t:'Čo by ste po liečbe chceli robiť, čo teraz nemôžete?',k:'long'}
];
export const QM={};Q.forEach(q=>{if(q.id)QM[q.id]=q});
// stav odpovedí, nad ktorým bežia pomôcky nižšie (nastavuje ho withState)
let S={};
const has=(id,i)=>Array.isArray(S[id])&&S[id].includes(i);
const anyOf=(id,a)=>a.some(i=>has(id,i));
const is=(id,i)=>S[id]===i;
const num=id=>{const v=parseFloat(S[id]);return isNaN(v)?null:v};
function answered(q){const v=S[q.id];
  if(q.k==='fields')return q.f.some(([f])=>S[f]);
  if(q.k==='scale'||q.k==='phq')return v&&Object.keys(v).length>0;
  if(q.k==='tx')return v&&Object.values(v).some(c=>c.t);
  if(q.id==='q22a')return ['q22a','q22b','q22c'].some(x=>S[x]!=null);
  return Array.isArray(v)?v.length>0:v!=null&&v!=='';}
export const GATES=['q20','gt','gs','gv','gu','gl'];
function derive(){
  if(S.gs===0){S.q8=0;S.q9=0}
  else if(S.gs===2){S.q8=4;if(S.q9===0)delete S.q9}
  else if(S.gs===3){S.q8=5;delete S.q9}
  else if(S.gs===1){if(S.q8>=4)delete S.q8;if(S.q9===0)delete S.q9}
  if(S.gs!==1&&S.q3){delete S.q3[4];delete S.q3[5]}
  if(is('q20',2)||is('q20',3)){if(S.q3)delete S.q3[3];delete S.q20b;delete S.q20k;delete S.q20d}
  if(S.gv===0){S.q11=[6];S.q12=0;['q11a','q11b','q11c','q12y','q12r'].forEach(k=>delete S[k])}
  else if(S.gv===1&&has('q11',6))S.q11=[];
  if(S.gu===0){S.q16=[9];delete S.q16n}
  else if(S.gu===1&&has('q16',9))S.q16=[];
  if(S.gt===0){S.q19g='0';S.q19p='0';S.q19c='0';['q19y','q19z','q19zt'].forEach(k=>delete S[k])}
  else if(S.gt===1&&S.q19g==='0'&&S.q19p==='0'){delete S.q19g;delete S.q19p;delete S.q19c}
  if(S.gl===0)delete S.q30;
}
const age=()=>{const b=num('by');if(!b)return null;return (S.fill?+S.fill.slice(0,4):Y)-b};
const bmi=()=>{const h=num('ht'),w=num('wt');return h&&w?w/((h/100)**2):null};
const DURMAX=[.25,.5,1,5,99];
function evalAll(){
  const red=[],ven=[],scr=[],proc=[],ctx=[];
  const A=age(),B=bmi(),menop=is('q20',3);
  const it=(arr,t,d,s,lvl)=>arr.push({t,d,s,lvl});
  // B4 varovné
  if(anyOf('q20x',[0,1,2]))it(red,'Abnormálne krvácanie',['medzi menštruáciami','po styku','po prechode'].filter((_,i)=>has('q20x',i)).join(', '),'položka 20','red');
  if(menop&&S.q1!=null&&num('q20m')){const since=Y-num('q20m');if(since>DURMAX[S.q1])it(red,'Bolesť pravdepodobne začala po menopauze',`menopauza ${num('q20m')}, trvanie bolesti: ${QM.q1.o[S.q1]}`,'položky 1, 20','red');else if(S.q1>=3)it(ctx,'Menopauza vs. začiatok bolesti nejasné','overiť, či bolesť predchádzala menopauze','položky 1, 20')}
  else if(menop)it(ctx,'Po menopauze','overiť, či bolesť nezačala po menopauze (chýba rok alebo trvanie)','položky 1, 20');
  if(anyOf('q16',[7,8]))it(red,'Hematúria',has('q16',7)?'makroskopická':'mikroskopická (z vyšetrenia moču)','položka 16','red');
  if(has('q18',5))it(red,'Krv v stolici','','položka 18','red');
  if(has('q18',3))it(red,'Nočná hnačka','','položka 18','red');
  if(is('q18f',1))it(red,'RA kolorektálneho Ca, IBD alebo celiakie','','položka 18','red');
  if(has('q18',6))it(red,'Nechcený úbytok hmotnosti','','položka 18','red');
  if(A!=null&&A>50&&(is('q17',1)||anyOf('q18',[0,1,2])))it(ctx,'Vek nad 50 s črevnými ťažkosťami','dotazník nezisťuje začiatok; overiť, či začali po 50. roku (varovný príznak)','položky 17, 18');
  // B2 venózne
  if(S.q1>=2)it(ven,'Trvanie ≥ 6 mesiacov','zodpovedá definícii chronickej panvovej bolesti; samo neodlišuje venóznu príčinu','SVP 2021');
  const vp=[has('q4',0)&&'tupá/ťažoba',has('q6',0)&&'státie',has('q6',3)&&'večer',anyOf('q7',[0,1])&&'úľava v ľahu',has('q6',4)&&'pred menštruáciou'].filter(Boolean);
  if(vp.length)it(ven,`Venózny vzorec: ${vp.length} z 5 znakov`,vp.join(', ')+'. V embolizačnej sérii zhoršenie večer aj pri státí 90,1 %, pred menštruáciou 75,3 %','Karakaya 2025, séria');
  if(anyOf('q8',[2,3]))it(ven,'Postkoitálna bolesť trvajúca hodiny',QM.q8.o[S.q8]+'. Doplniť palpáciu ovariálneho bodu (kombinácia: sens 94 %, spec 77 %, jedna staršia štúdia)','SVP 2021; Borghi 2016');
  if(is('q5',2))it(ven,'Bolesť len cyklická','najprv vylúčiť endometriózu a adenomyózu','Szkodziak 2025');
  if(anyOf('q11',[0,1,2,3]))it(ven,'Atypické varixy (SVP V3a/V3b)',['vulva','hrádza','zadok','stehno'].filter((_,i)=>has('q11',i)).join(', ')+'. Zaradenie a/b podľa vyšetrenia. V3b: nezávislý prediktor recidívy, OR 16,16','Yamamoto-Ramos 2026');
  if(is('q12r',1))it(ven,'Recidíva varixov po operácii','podozrenie na panvový zdroj (recidíva po strippingu 75 % vo flebografickej sérii)','Asciutto 2009');
  if(anyOf('q13',[0,2,4])||has('q15',1))it(ven,'Podozrenie na iliakálnu obštrukciu (SVP S3c)',[has('q13',0)&&'opuch ĽDK',has('q13',2)&&'opuch celej končatiny',has('q13',4)&&'venózna klaudikácia',has('q15',1)&&'prekonaná TVT'].filter(Boolean).join(', ')+'. Pri hemodynamicky významnej lézii pomohol stent ako prvý v 69,4 %','Gavrilov 2026');
  if(has('q2',4)&&anyOf('q16',[7,8]))it(ven,'Ľavý bok + hematúria: podozrenie na kompresiu ĽRV (SVP S1)',`BMI ${B?B.toFixed(1):'nezadané'} (prah „nízkeho BMI" zdroj neuvádza). Pred embolizáciou oklúzny test. Hematúria = aj varovný príznak`,'Scultetus 2001, séria');
  if(has('q16',0))it(ven,'Močová urgencia','spájala sa s neúplným klinickým úspechom embolizácie','Nasser 2014');
  const g=num('q19g'),p=num('q19p');
  if(g===0)it(ven,'Nulipara','reflux v ĽOV 21,4 % nulipár vs. 90,6 % po 2 graviditách; u nulipary hľadať obštrukciu','Szary 2021');
  if(p!=null&&p>=3)it(ven,`Parita ${p}`,'parita ≥ 3 predikovala horšiu odpoveď na embolizáciu, OR 2,27','Wang 2025');
  if(anyOf('q23',[0,1,2]))it(ven,'Estrogén-dependentné ochorenie',['endometrióza','adenomyóza','myómy'].filter((_,i)=>has('q23',i)).join(', ')+'. Horšia odpoveď na embolizáciu, OR 2,59. Zdroj nešpecifikuje, či zahŕňa myómy','Wang 2025');
  const cs=['fibromyalgia','migréna','chronická únava','POTS'].filter((_,i)=>has('q25',i+2));
  if(cs.length)it(ven,'Znaky centrálnej senzitizácie',cs.join(', ')+'; môžu obmedziť efekt liečby žíl','SIR 2026');
  if(has('q25',6))it(ven,'Hypermobilita / EDS','zaznamenať; v kľúči B2 nemá vlastný riadok','—');
  // B3 skríning
  const ibs=is('q17',1)?(S.q17s||[]).length:null;
  it(scr,'Syndróm dráždivého čreva',ibs==null?'negatívny':ibs>=2?`pozitívny (${ibs} z 3). Začiatok > 6 mes. dotazník nezisťuje`:`neúplný (${ibs} z 3)`,'Rome IV',ibs>=2?'flag':'');
  const bps=has('q16',3)&&anyOf('q16',[0,1]);
  it(scr,'Bolestivý mechúr',bps?'pozitívny: doplniť ICSI (≥ 5: sens 94 %); urológ. Pozn.: položka 16 nerozlišuje urgenciu „pre bolesť"':'negatívny','RICE; Clemons 2002',bps?'flag':'');
  const en=[is('q20b',1)&&'silná dysmenorea',anyOf('q9',[1,3])&&'hlboká dyspareunia',has('q18',4)&&'bolestivá stolica pri menštruácii',is('q22c',1)&&'neplodnosť',is('q23f',1)&&'RA endometriózy'].filter(Boolean);
  it(scr,`Endometrióza: ${en.length} z 5 príznakov`,(en.join(', ')||'žiadny')+'. Bez prahu; pravdepodobnosť rastie s počtom','ACOG 2026',en.length>=2?'flag':'');
  it(scr,'Vulvodýnia',is('q27',1)?'pozitívny: gynekológ':'negatívny','Reed 2006',is('q27',1)?'flag':'');
  const pud=is('q26',1);
  it(scr,'Pudendálna neuralgia',pud?(is('q10',1)?'bolesť pri sedení, ALE budí zo spánku: nesedí s Nantskými kritériami, dôvod na MR':'pozitívny: neurológ / ambulancia bolesti')+(has('q4',3)?'; pálivá bolesť':''):'negatívny','Nantes; Labat 2007',pud?'flag':'');
  if(has('q4',0)&&has('q6',2))it(scr,'Myofasciálna bolesť panvového dna','ťažoba + zhoršenie pri chôdzi sa prekrýva s venóznym vzorcom; dotazník neodlíši, vyšetriť tonus','Till 2026');
  const ph=S.q28||{},dep=(ph[0]??0)+(ph[1]??0),anx=(ph[2]??0)+(ph[3]??0),dOk=ph[0]!=null&&ph[1]!=null,aOk=ph[2]!=null&&ph[3]!=null;
  it(scr,`Depresia (PHQ-2): ${dOk?dep:'—'}`,dOk?(dep>=3?'≥ 3: PHQ-9 pri návšteve (sens 0,72, spec 0,85)':'pod prahom 3'):'nevyplnené','Levis 2020',dOk&&dep>=3?'flag':'');
  it(scr,`Úzkosť (GAD-2): ${aOk?anx:'—'}`,aOk?(anx>=3?'≥ 3: GAD-7 (spec 0,86)':'pod prahom 3'):'nevyplnené','USPSTF 2023',aOk&&anx>=3?'flag':'');
  if(is('q29',0))it(red,'Pacientka chce hovoriť o násilí/zneužívaní','venovať čas pri návšteve; cesta k psychológovi','položka 29','red');
  // B5
  if(!menop)it(proc,is('q22a',1)||is('q22a',2)?'Možná gravidita':'Fertilný vek','β-hCG do 2 týždňov pred výkonom'+(S.q20d?`; posledná menštruácia ${S.q20d}`:''),'Bashore 2012',is('q22a',1)||is('q22a',2)?'red':'');
  if(has('q31',0))it(proc,'Alergia na kontrast',(S.q31k?S.q31k+'. ':'')+'premedikácia podľa protokolu alebo CO₂ venografia','protokol pracoviska','flag');
  if(has('q31',1))it(proc,'Anamnéza alergie na nikel','zvážiť epikutánny test pred stentovaním (anamnéza sama nevýznamná; potvrdená alergia OR 2,61; nitinol ~55 % Ni)','Guéroult 2022','flag');
  if(has('q31',2))it(proc,'Alergia na lieky',S.q31l||'nešpecifikované','—');
  if(has('q15',1)||is('q15t',1)||is('q32',1))it(proc,'Trombóza / trombofília / antikoagulancia',[has('q15',1)&&'prekonaná TVT '+(S.q15y||''),is('q15t',1)&&'trombofília',is('q32',1)&&'antikoagulancia: '+(S.q32t||'?')].filter(Boolean).join('; ')+'. Po coilingu ovariálnych žíl skríningom trombóza panvových žíl 24 %','Gavrilov 2023','flag');
  if(anyOf('q21',[0,1]))it(proc,'Hormonálna antikoncepcia (tabletky/náplasť/krúžok)',(S.q21n?S.q21n+'. ':'')+'overiť, či kombinovaná (riziko VTE ~3,5×). Odporúčanie o vysadení pred embolizáciou sa nenašlo','Skeith 2026');
  if(anyOf('q22b',[1,2]))it(proc,'Plánované tehotenstvo','zahrnúť do poučenia: obmedzené dáta nesvedčia pre poškodenie fertility'+(A!=null&&A<30?'; vek < 30: AMH klesol viac, než zodpovedá veku':''),'SIR 2026; Karakaya 2025');
  // q30
  const fail=(S.q30?Object.entries(S.q30):[]).filter(([,c])=>c.t);
  const tx=fail.map(([i,c])=>`${QM.q30.r[i].replace(/ \(.*\)/,'')}${c.d?' ('+c.d+')':''}: pomohlo ${c.e!=null?QM.q30.o[c.e]:'neuvedené'}`);
  return {red,ven,scr,proc,ctx,A,B,tx};
}
function anam(E){
  const P=[];
  const v=k=>S[k]!=null&&S[k]!==''?S[k]:null;
  const ms=(id,map)=>(S[id]||[]).map(i=>(map||QM[id].o)[i]);
  const fd=d=>{const p=(d||'').split('-');return p.length===3?`${+p[2]}.${+p[1]}.${p[0]}`:d};
  const yn=(id,a,b)=>S[id]===1?a:S[id]===0?b:null;
  const cap=s=>s?s[0].toUpperCase()+s.slice(1):s;
  const sec=(h,arr)=>{const t=arr.filter(Boolean);if(t.length)P.push(`${h}: ${t.join(' ')}`)};
  const nx=(id,ex,pre,none)=>{const a=S[id]||[];if(!a.length)return null;return a.includes(ex)?none:pre+ms(id).join(', ')+'.'};
  P.push(`Anamnéza z dotazníka vyplneného pacientkou${S.fill?' '+fd(S.fill):''}${v('pid')?' (č. objednávky '+v('pid')+')':''}.`);
  const bas=[E.A!=null&&`vek ${E.A} r.`,num('ht')&&`výška ${num('ht')} cm`,num('wt')&&`hmotnosť ${num('wt')} kg`,E.B&&`BMI ${E.B.toFixed(1).replace('.',',')} kg/m²`].filter(Boolean);
  if(bas.length)P.push(cap(bas.join(', ')).replace(/\.?$/,'.'));
  const loc=(S.q2||[]).map(i=>i===9&&v('q2s')?`stehno (${S.q2s})`:QM.q2.o[i]);
  const nrs=['priemer','maximum','pri státí','pri menštruácii','počas styku','po styku'].map((l,i)=>S.q3?.[i]!=null?`${l} ${S.q3[i]}`:null).filter(Boolean);
  sec('NO',[
    S.q1!=null&&`Bolesti v podbrušku a panve trvajú ${QM.q1.o[S.q1]}.`,
    loc.length&&`Lokalizácia: ${loc.join(', ')}.`,
    S.q4?.length&&`Charakter: ${ms('q4').join(', ')}.`,
    S.q5!=null&&'Bolesť '+['prítomná väčšinu dní','intermitentná, bez vzťahu k menštruácii','len perimenštruačne'][S.q5]+'.',
    nrs.length&&`NRS (0–10): ${nrs.join(', ')}.`,
    nx('q6',9,'Zhoršuje: ','Zhoršujúce faktory neudáva.'),
    nx('q7',5,'Úľava: ','Úľavu neprináša nič.'),
    S.q8!=null&&cap(['postkoitálnu bolesť neudáva','postkoitálna tupá bolesť do 1 h','postkoitálna tupá bolesť niekoľko hodín','postkoitálna tupá bolesť do druhého dňa','pohlavný styk nemá pre bolesť','pohlavný styk nemá z iného dôvodu'][S.q8])+'.',
    S.q9!=null&&cap(['dyspareuniu neudáva','hlboká dyspareunia','povrchová dyspareunia','hlboká aj povrchová dyspareunia'][S.q9])+'.',
    yn('q10','Bolesť ju budí zo spánku.','Zo spánku ju nebudí.')
  ]);
  const vx=S.q11||[];
  const q13m=['opuch ľavej DK','opuch pravej DK','opuch celej DK až po inguinu','pocit ťažkých nôh','napätie pri chôdzi ustupujúce po elevácii (venózna klaudikácia)'];
  sec('Venózna anamnéza',[
    vx.length&&(vx.includes(6)?'Varixy neudáva.':`Varixy: ${ms('q11').join(', ')}`+[S.q11a===1&&`, vznik v gravidite${v('q11b')?' ('+S.q11b+')':''}`,S.q11a===0&&', vznik mimo gravidity',S.q11c===1&&', premenštruačne sa zväčšujú alebo bolia',S.q11c===0&&', bez cyklických zmien'].filter(Boolean).join('')+'.'),
    S.q12===1&&`St. p. operácii, laseri alebo skleroterapii varixov DK${v('q12y')?' ('+S.q12y+')':''}${S.q12r===1?', s recidívou':S.q12r===0?', bez recidívy':''}.`,
    S.q12===0&&'Intervenciu na varixoch DK neudáva.',
    S.q13?.length&&(S.q13.includes(5)?'Opuchy, ťažké nohy ani venóznu klaudikáciu neudáva.':`Udáva: ${ms('q13',q13m).join(', ')}.`),
    yn('q14','Hemoroidy.','Hemoroidy neudáva.'),
    S.q15?.length&&(S.q15.includes(0)?'TVT ani PE v OA a RA neudáva.':[has('q15',1)&&`TVT/PE v OA${v('q15y')?' ('+S.q15y+')':''}.`,has('q15',2)&&`TVT/PE v RA${v('q15k')?' ('+S.q15k+')':''}.`].filter(Boolean).join(' ')),
    S.q15t!=null&&['Trombofíliu neudáva.','Zistená trombofília.','O trombofílii nevie.'][S.q15t],
    yn('q15v','Varixy u rodičov alebo súrodencov.','Varixy u rodičov a súrodencov neudáva.')
  ]);
  const q16m=['urgencia','frekvencia ≥ 10× cez deň',`nyktúria${v('q16n')?' '+S.q16n+'×':''}`,'bolesť alebo tlak v mechúre zhoršujúce sa pri plnení','úľava po mikcii','pálenie pri močení bez potvrdenej infekcie','inkontinencia','makroskopická hematúria','mikroskopická hematúria'];
  sec('Urologická',[S.q16?.length&&(S.q16.includes(9)?'Mikčné ťažkosti ani hematúriu neudáva.':cap(ms('q16',q16m).join(', '))+'.')]);
  const q17m=['vzťah k defekácii','zmena frekvencie stolice','zmena konzistencie stolice'];
  const q18m=['nadúvanie','zápcha','hnačka','nočná hnačka','bolestivá defekácia pri menštruácii','krv v stolici','nechcený úbytok hmotnosti'];
  sec('GIT',[
    S.q17===1&&`Bolesť brucha ≥ 1 deň v týždni posledné 3 mesiace${S.q17s?.length?': '+ms('q17s',q17m).join(', '):''}.`,
    S.q17===0&&'Bolesť brucha ≥ 1 deň v týždni posledné 3 mesiace neudáva.',
    S.q18?.length&&(S.q18.includes(7)?'Ďalšie GIT ťažkosti neudáva.':cap(ms('q18',q18m).join(', '))+'.'),
    yn('q18f','V RA kolorektálny karcinóm, IBD alebo celiakia.','RA kolorektálneho karcinómu, IBD a celiakie negatívna.')
  ]);
  const ob=[v('q19g')!=null&&'G'+S.q19g,v('q19p')!=null&&'P'+S.q19p].filter(Boolean).join(' ')+(v('q19c')!=null?`, z toho SC ${S.q19c}`:'')+(v('q19y')?`, posledný pôrod ${S.q19y}`:'');
  sec('GA',[
    S.gt===0?'G0, nikdy nebola tehotná.':ob&&ob.replace(/^, /,'')+'.',
    S.q19z===1&&`Bolesti začali alebo sa zhoršili po tehotenstve${v('q19zt')?' ('+S.q19zt+')':''}.`,
    S.q19z===0&&'Bez vzťahu bolesti k tehotenstvu.',
    S.q20!=null&&['Menštruácia pravidelná','Menštruácia nepravidelná','Bez menštruácie pri hormonálnej liečbe','Postmenopauza'][S.q20]+(S.q20===3&&v('q20m')?` (posledná menštruácia ${S.q20m})`:'')+(S.q20!==3&&v('q20d')?`, PM ${fd(S.q20d)}`:'')+'.',
    S.q20!==3&&S.q20b!=null&&['Dysmenorea žiadna alebo mierna.','Silná, obmedzujúca dysmenorea.'][S.q20b],
    S.q20!==3&&S.q20k!=null&&['Menštruačné krvácanie primerané.','Veľmi silné menštruačné krvácanie.'][S.q20k],
    S.q20x?.length&&cap(ms('q20x',['intermenštruačné krvácanie','postkoitálne krvácanie','postmenopauzálne krvácanie']).join(', '))+'.',
    S.q21?.length&&(S.q21.includes(5)?'Hormonálnu antikoncepciu ani HRT neužíva.':`Hormonálna liečba: ${ms('q21',['tabletky','náplasť alebo krúžok','LNG-IUS','implantát alebo injekcie','HRT']).join(', ')}${v('q21n')?' ('+S.q21n+')':''}.`),
    S.q22a!=null&&['Možnosť gravidity neudáva.','Udáva možnú graviditu.','Graviditu nevie vylúčiť.'][S.q22a],
    S.q22b!=null&&['Graviditu neplánuje.','Plánuje graviditu.','Plánovanie gravidity nejasné.'][S.q22b],
    yn('q22c','Ťažkosti s otehotnením.','Ťažkosti s otehotnením neudáva.'),
    S.q23?.length&&(S.q23.includes(6)?'Endometriózu, adenomyózu, myómy, cysty, PID ani panvové varixy v minulosti nezistené.':`V minulosti zistené: ${ms('q23',['endometrióza','adenomyóza','myómy','cysty ovárií','PID','panvové varixy']).join(', ')}.`),
    S.q23f!=null&&['Endometriózu u matky a sestry neudáva.','Endometrióza u matky alebo sestry.','Endometrióza u matky alebo sestry: nevie.'][S.q23f]
  ]);
  sec('Operácie',[v('q24')]);
  sec('Pridružené ochorenia',[
    S.q25?.length&&(S.q25.includes(10)?'Neudáva.':cap(ms('q25',['IBS','intersticiálna cystitída / bolestivý mechúr','fibromyalgia','migréna','chronický únavový syndróm','POTS','hypermobilita / EDS','depresia','úzkostná porucha','chronická bolesť krížov']).join(', '))+'.'),
    yn('q26','Bolesť v perineu, vagíne alebo rekte najhoršia pri sedení.','Bolesť v perineu najhoršiu pri sedení neudáva.'),
    yn('q27','Bolesť pri dotyku vestibula vagíny > 3 mesiace.','Bolesť pri dotyku vestibula neudáva.')
  ]);
  const ph=S.q28||{};
  sec('Skríning nálady',[ph[0]!=null&&ph[1]!=null&&`PHQ-2 ${ph[0]+ph[1]}/6.`,ph[2]!=null&&ph[3]!=null&&`GAD-2 ${ph[2]+ph[3]}/6.`]);
  sec('Doterajšia liečba',[E.tx.length&&E.tx.join('; ')+'.',S.gl===0&&'Pre tieto bolesti zatiaľ liečená nebola.']);
  const al=S.q31||[];
  sec('AA',[al.length&&(al.includes(3)?'Alergie neudáva.':cap([has('q31',0)&&`kontrastná látka${v('q31k')?' ('+S.q31k+')':''}`,has('q31',1)&&'nikel (anamnesticky)',has('q31',2)&&`lieky${v('q31l')?' ('+S.q31l+')':''}`].filter(Boolean).join(', '))+'.')]);
  sec('FA',[yn('q32',`Lieky na riedenie krvi: ${v('q32t')||'áno, bez názvu'}.`,'Lieky na riedenie krvi neužíva.'),v('q33')&&`Pravidelne: ${S.q33}`]);
  const lim=QM.q34.r.map((r,i)=>S.q34?.[i]!=null?`${r.toLowerCase()} ${S.q34[i]}`:null).filter(Boolean);
  sec('Obmedzenie bolesťou za posledný mesiac (0–10)',[lim.length&&lim.join(', ')+'.']);
  sec('Cieľ pacientky',[v('q35')]);
  return P.join('\n');
}
function evalTxt(E){
  const L=[],f=a=>a.map(x=>`- ${x.t}${x.d?': '+x.d:''}`).join('\n');
  L.push('VYHODNOTENIE DOTAZNÍKA');
  // položka 29 (násilie) zámerne nejde do textu správy — len do náhľadu lekára
  L.push('\nVAROVNÉ PRÍZNAKY:\n'+(f(E.red.filter(x=>x.s!=='položka 29'))||'- neuvedené'));
  if(E.ctx.length)L.push('\nOVERIŤ:\n'+f(E.ctx));
  L.push('\nVENÓZNE ZNAKY (nevalidované, len anamnéza):\n'+(f(E.ven)||'- žiadne'));
  L.push('\nSKRÍNING INÝCH PRÍČIN:\n'+f(E.scr));
  L.push('\nPRED VÝKONOM:\n'+(f(E.proc)||'- bez záznamu'));
  if(E.tx.length)L.push('\nDOTERAJŠIA LIEČBA:\n'+E.tx.map(t=>'- '+t).join('\n'));
  L.push('\n[Dotazník nie je validovaný diagnostický test; nemá skóre ani prah.]');
  return L.join('\n');
}

// ---------- verejné rozhranie (čisté funkcie nad kópiou stavu) ----------
const withState=(state,fn)=>{const prev=S;S=state;try{return fn()}finally{S=prev}};
export const NUMBERED=(q)=>Boolean(q.n||q.g);
// je otázka (alebo riadok škály) viditeľná pri daných odpovediach?
export const isVisible=(q,state)=>!q.sh||withState(state,()=>Boolean(q.sh()));
export const rowVisible=(q,ri,state)=>!q.rs?.[ri]||withState(state,()=>Boolean(q.rs[ri]()));
export const isAnswered=(q,state)=>withState(state,()=>Boolean(answered(q)));
// po zmene odpovede: doplní/odstráni odpovede, ktoré určuje rozcestník (vracia novú kópiu)
export function applyGates(state){const c=JSON.parse(JSON.stringify(state||{}));withState(c,derive);return c}
// ukáže sa pri výbere „nič z uvedeného" zrušiť ostatné (a naopak)
export function toggleMany(state,id,v,checked){
  const q=QM[id];let a=Array.isArray(state[id])?[...state[id]]:[];
  if(checked){a=a.filter(x=>x!==v);a.push(v);if(q.ex!=null)a=v===q.ex?[v]:a.filter(x=>x!==q.ex)}
  else a=a.filter(x=>x!==v);
  return {...state,[id]:a.sort((x,y)=>x-y)};
}
export function progress(state){
  const nq=Q.filter(q=>NUMBERED(q)&&isVisible(q,state));
  return {done:nq.filter(q=>isAnswered(q,state)).length,total:nq.length};
}
export function missingNumbers(state){return Q.filter(q=>q.n&&isVisible(q,state)&&!isAnswered(q,state)).map(q=>q.n)}
// vyhodnotenie (kľúč pre lekára) a text do správy; meta: {birthYear, submittedAt, orderId}
const withMeta=(answers,meta={})=>({...(answers||{}),by:meta.birthYear??null,fill:(meta.submittedAt||'').slice(0,10),pid:meta.orderId||''});
export function evaluate(answers,meta){return withState(withMeta(answers,meta),()=>{const E=evalAll();return {...E,age:E.A,bmi:E.B}})}
export function reportText(answers,meta){return withState(withMeta(answers,meta),()=>{const E=evalAll();return anam(E)+'\n\n'+evalTxt(E)})}

// ---------- dáta (dotaznik-001) ----------
// Demo režim (bez databázy): localStorage — kľúče podľa objednávky.
const DEMO_KEY='angioQuestionnaires_v1';
const NEED_SQL='Dotazník ešte nie je zapnutý v databáze (spustite supabase/dotaznik-001.sql).';
const demoLoad=()=>{try{return JSON.parse(localStorage.getItem(DEMO_KEY)||'{}')}catch{return {}}};
const demoSave=(m)=>localStorage.setItem(DEMO_KEY,JSON.stringify(m));
const rnd=()=>{const b=new Uint8Array(16);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,'0')).join('')};
const rpcErr=(error)=>new Error(error.code==='PGRST202'?NEED_SQL:error.message);
// adresa pacientskej stránky: beta správa posiela odkaz na beta (zdieľaná databáza)
export const patientBase=()=>{const p=window.location.pathname||'';return `https://objednanie.cievny.sk/${p.includes('/beta/')?'beta/':''}`};
export const questionnaireLink=(token,base=patientBase())=>`${base}#/angio1/dotaznik/${token}`;

export const questionnaireApi={
  async status(orderId){
    if(!supabase){const q=demoLoad()[orderId];return q?{exists:true,sentAt:q.sentAt||null,sentBy:q.sentBy||'',sentVia:q.sentVia||'',submittedAt:q.submittedAt||null,token:q.submittedAt?null:q.token,canRead:true,canSend:true}:{exists:false,canRead:true,canSend:true}}
    const {data,error}=await supabase.rpc('angio_q_status',{p_order_id:orderId});
    if(error)throw rpcErr(error);
    return {exists:Boolean(data.exists),sentAt:data.sent_at||null,sentBy:data.sent_by||'',sentVia:data.sent_via||'',submittedAt:data.submitted_at||null,token:data.token||null,canRead:Boolean(data.can_read),canSend:Boolean(data.can_send)};
  },
  async send(orderId,send=true){
    if(!supabase){const m=demoLoad();const q=m[orderId]||{token:rnd(),orderId};if(q.submittedAt)throw new Error('Pacientka dotazník už vyplnila.');if(send){q.sentAt=new Date().toISOString();q.sentVia='SMS, e-mail (demo — nič sa neodoslalo)';q.sentBy='demo'}m[orderId]=q;demoSave(m);return {token:q.token,link:questionnaireLink(q.token),sentVia:send?q.sentVia:'',warning:''}}
    const {data,error}=await supabase.rpc('angio_q_send',{p_order_id:orderId,p_base:patientBase(),p_send:send});
    if(error)throw rpcErr(error);
    return {token:data.token,link:data.link,sentVia:data.sent_via||'',warning:data.warning||''};
  },
  async get(orderId){
    if(!supabase){const q=demoLoad()[orderId];if(!q?.submittedAt)throw new Error('Dotazník zatiaľ nie je vyplnený.');return {answers:q.answers,submittedAt:q.submittedAt,birthYear:q.birthYear??null,orderId}}
    const {data,error}=await supabase.rpc('angio_q_get',{p_order_id:orderId});
    if(error)throw rpcErr(error);
    return {answers:data.answers||{},submittedAt:data.submitted_at,birthYear:data.birth_year??null,orderId:data.order_id};
  },
  async open(token){
    if(!supabase){const q=Object.values(demoLoad()).find(x=>x.token===token);if(!q)return {state:'invalid'};return q.submittedAt?{state:'submitted'}:{state:'open',slotDate:null}}
    const {data,error}=await supabase.rpc('angio_q_open',{p_token:token});
    if(error)throw rpcErr(error);
    return {state:data.state,slotDate:data.slot_date||null};
  },
  async submit(token,answers){
    if(!supabase){const m=demoLoad();const k=Object.keys(m).find(id=>m[id].token===token);if(!k)throw new Error('Odkaz na dotazník je neplatný.');if(m[k].submittedAt)throw new Error('Dotazník už bol odoslaný. Ďakujeme.');m[k].answers=answers;m[k].submittedAt=new Date().toISOString();demoSave(m);return}
    const {error}=await supabase.rpc('angio_q_submit',{p_token:token,p_answers:answers});
    if(error)throw rpcErr(error);
  },
};
// pred odoslaním: zahodiť doplňujúce texty k otázkam, ktoré sa medzičasom skryli
export function cleanForSubmit(state){
  const c=applyGates(state);
  Q.forEach(q=>{if(q.id&&['text','num','date'].includes(q.k)&&!isVisible(q,c))delete c[q.id]});
  Object.keys(c).forEach(k=>{const v=c[k];if(v===''||v==null||(Array.isArray(v)&&!v.length)||(typeof v==='object'&&!Array.isArray(v)&&!Object.keys(v).length))delete c[k]});
  return c;
}
