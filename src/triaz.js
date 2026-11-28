// Triáž žiadostí o konzultáciu (verejný formulár z Instagramu, #/konzultacia).
//
// Jeden súbor pre formulár aj pre prehľad lekára:
//   • RED_FLAGS, TOPICS  — otázky formulára,
//   • classify(request)  — NÁVRH zaradenia pre lekára (nie diagnóza, nie odpoveď pacientovi),
//   • summarize(request) — čitateľný výpis odpovedí.
// Zaradenie sa počíta až pri zobrazení (databáza ukladá len odpovede), takže po
// úprave pravidiel sa prepočítajú aj staršie žiadosti.
//
// Kategórie:  akutne  — možný akútny stav (pacient dostal pokyn ihneď na obrazovke)
//             ustav   — pre ústav: kandidát na intervenciu / špecializované riešenie
//             angiolog — rajónny angiológ (diagnostika, sledovanie, konzervatívna liečba)
//             obvodny — všeobecný (obvodný) lekár
//             posudit — nedá sa zaradiť z odpovedí, treba prečítať text
// Priorita:   1 prednostne · 2 bežne · 3 nízka
//
// PRAVIDLÁ SÚ NÁVRH NA ODSÚHLASENIE LEKÁROM — upravujú sa len v tomto súbore.

export const CATEGORIES = {
  akutne: { label: "Akútne", long: "Možný akútny stav", tone: "danger" },
  ustav: { label: "Ústav", long: "Pre ústav — intervencia / špecializované riešenie", tone: "brand" },
  posudit: { label: "Na posúdenie", long: "Nedá sa zaradiť z odpovedí — prečítať text", tone: "warn" },
  angiolog: { label: "Rajónny angiológ", long: "Rajónny angiológ — diagnostika, sledovanie", tone: "muted" },
  obvodny: { label: "Obvodný lekár", long: "Všeobecný (obvodný) lekár", tone: "muted" },
};
export const CATEGORY_ORDER = ["akutne", "ustav", "posudit", "angiolog", "obvodny"];
export const PRIORITY_LABEL = { 1: "prednostne", 2: "bežne", 3: "nízka priorita" };

// ---------- akútne príznaky (prvá otázka formulára) ----------
// call155: true = volať 155; false = lekár ešte dnes (pohotovosť / urgentný príjem)
export const RED_FLAGS = [
  { id: "rf_ischemia", call155: true, label: "Náhle (hodiny až dni) studená, bledá alebo necitlivá noha či ruka so silnou bolesťou", short: "náhle studená / bledá končatina s bolesťou" },
  { id: "rf_pe", call155: true, label: "Dýchavica, bolesť na hrudi alebo vykašliavanie krvi", short: "dýchavica / bolesť na hrudi" },
  { id: "rf_stroke", call155: true, label: "Náhla slabosť ruky či nohy, porucha reči, ovisnutý kútik úst alebo výpadok zraku", short: "príznaky mozgovej príhody" },
  { id: "rf_aaa", call155: true, label: "Náhla prudká bolesť brucha alebo chrbta pri známej vydutine (aneuryzme) aorty", short: "prudká bolesť pri známej aneuryzme" },
  { id: "rf_dvt", call155: false, label: "Náhly opuch jednej nohy s bolesťou alebo začervenaním (posledné dni)", short: "náhly bolestivý opuch jednej nohy" },
  { id: "rf_infection", call155: false, label: "Rana s hnisom, šíriacim sa začervenaním, černaním tkaniva alebo s horúčkou", short: "rana s infekciou / černaním" },
];

const YN = [["ano", "Áno"], ["nie", "Nie"]];
const q = (id, label, options, extra = {}) => ({ id, label, options: options.map(([value, text]) => ({ value, label: text })), ...extra });

// ---------- témy a doplňujúce otázky ----------
export const TOPICS = [
  { id: "varixy", label: "Kŕčové žily (varixy), metličky", questions: [
    q("v_typ", "Čo najlepšie vystihuje váš stav?", [["metlicky", "Len drobné žilky (metličky)"], ["varixy", "Viditeľné, vystúpené kŕčové žily"],
      ["koza", "Kŕčové žily so zmenou kože (hnedé sfarbenie, ekzém, stvrdnutie)"], ["vred", "Vred alebo rana pri členku"]]),
    q("v_tazkosti", "Máte ťažkosti — bolesť, pocit ťažkých nôh, opuchy, kŕče?", YN),
    q("v_zapal", "Mali ste zápal alebo trombózu povrchových žíl?", YN),
    q("v_ciel", "Čo očakávate?", [["zakrok", "Chcem zákrok (RFA / laser, skleroterapia, operácia)"], ["rada", "Chcem vyšetrenie a radu"], ["vzhlad", "Ide mi hlavne o vzhľad"]]),
    q("v_usg", "Máte už ultrazvukové (duplexné) vyšetrenie žíl?", YN),
  ] },
  { id: "chodza", label: "Bolesť nôh pri chôdzi, zlé prekrvenie nôh", questions: [
    q("c_vzdialenost", "Po akej vzdialenosti musíte pre bolesť zastať?", [["pokoj", "Bolí aj v pokoji alebo v noci"], ["do50", "Menej ako 50 metrov"], ["50_200", "50 až 200 metrov"],
      ["nad200", "Viac ako 200 metrov"], ["nesuvisi", "Bolesť s chôdzou nesúvisí / neviem"]]),
    q("c_cukrovka", "Máte cukrovku?", YN),
    q("c_fajcenie", "Fajčíte?", YN),
    q("c_vysetreny", "Boli ste s tým už vyšetrený(á)?", [["nie", "Nie"], ["obvodny", "Áno, u všeobecného lekára"], ["angiolog", "Áno, u angiológa alebo cievneho chirurga"]]),
    q("c_nalez", "Máte nález o zúžení alebo uzávere tepien (ultrazvuk, CT angiografia)?", YN),
    q("c_zakrok", "Odporučil vám lekár zákrok (angioplastika, stent, bypass)?", YN),
  ] },
  { id: "rana", label: "Rana alebo vred na nohe, ktorý sa nehojí", questions: [
    q("r_trvanie", "Ako dlho ranu máte?", [["do2", "Menej ako 2 týždne"], ["2_6", "2 až 6 týždňov"], ["nad6", "Viac ako 6 týždňov"]]),
    q("r_miesto", "Kde je rana?", [["prsty", "Prsty alebo predná časť chodidla"], ["pata", "Päta"], ["clenok", "Okolie členka alebo predkolenie"], ["inde", "Inde"]]),
    q("r_cukrovka", "Máte cukrovku?", YN),
    q("r_pokoj", "Bolí vás noha v pokoji alebo v noci?", YN),
    q("r_cierne", "Je časť prsta alebo kože čierna (suchá)?", YN),
  ] },
  { id: "opuch", label: "Opuch nohy alebo nôh", questions: [
    q("o_strana", "Opúcha", [["jedna", "Jedna noha"], ["obe", "Obe nohy"]]),
    q("o_trvanie", "Ako dlho?", [["dni", "Niekoľko dní (vzniklo náhle)"], ["tyzdne", "Týždne"], ["mesiace", "Mesiace až roky"]]),
    q("o_bolest", "Je noha bolestivá, teplá alebo začervenaná?", YN),
    q("o_po_tromboze", "Mali ste v minulosti trombózu tej nohy?", YN),
  ] },
  { id: "tromboza", label: "Trombóza alebo zápal žíl (prekonaný alebo liečený)", questions: [
    q("t_kedy", "Kedy ste ju mali?", [["teraz", "Teraz / v posledných 4 týždňoch"], ["do_roka", "Pred 1 až 12 mesiacmi"], ["davno", "Pred viac ako rokom"]]),
    q("t_kde", "O aké žily išlo?", [["hlboke", "Hlboké žily (trombóza)"], ["povrchove", "Povrchové žily (zápal žíl)"], ["neviem", "Neviem"]]),
    q("t_rozsah", "Kde trombóza bola?", [["lytko", "Lýtko"], ["stehno", "Stehno alebo panva"], ["neviem", "Neviem"]]),
    q("t_tazkosti", "Máte na tej nohe pretrvávajúci opuch, bolesť alebo ranu?", YN),
    q("t_lieky", "Užívate lieky na riedenie krvi?", YN),
  ] },
  { id: "karotidy", label: "Zúženie krčných tepien (karotíd)", questions: [
    q("k_stupen", "Viete, aké veľké je zúženie?", [["do50", "Menej ako 50 %"], ["50_69", "50 až 69 %"], ["nad70", "70 % a viac"], ["uzaver", "Úplný uzáver"], ["neviem", "Neviem"]]),
    q("k_prihoda", "Mali ste za posledných 6 mesiacov mozgovú príhodu, prechodné ochrnutie, poruchu reči alebo výpadok zraku?", YN),
    q("k_zakrok", "Odporučil vám lekár zákrok (stent alebo operácia)?", YN),
  ] },
  { id: "aneuryzma", label: "Vydutina (aneuryzma) aorty alebo inej tepny", questions: [
    q("a_kde", "Kde je vydutina?", [["brusna", "Brušná aorta"], ["hrudna", "Hrudná aorta"], ["koncatina", "Tepna v podkolení alebo v stehne"], ["neviem", "Iná / neviem"]]),
    q("a_velkost", "Aká je veľká?", [["do4", "Menej ako 4 cm"], ["4_49", "4 až 4,9 cm"], ["nad5", "5 cm a viac"], ["neviem", "Neviem"]]),
    q("a_rast", "Zväčšila sa za posledný rok?", [["ano", "Áno"], ["nie", "Nie"], ["neviem", "Neviem"]]),
    q("a_zakrok", "Odporučil vám lekár zákrok?", YN),
  ] },
  { id: "renalne", label: "Zúženie obličkových tepien, ťažko liečiteľný vysoký tlak", questions: [
    q("n_nalez", "Máte nález o zúžení obličkovej (renálnej) tepny (ultrazvuk, CT alebo MR angiografia)?", [["nad70", "Áno, významné (70 % a viac)"], ["do70", "Áno, menej významné alebo neviem koľko"], ["nie", "Nie"]]),
    q("n_tlak", "Máte vysoký tlak, ktorý sa nedarí upraviť ani tromi a viac liekmi?", YN),
    q("n_oblicky", "Zhoršuje sa vám funkcia obličiek (stúpa kreatinín)?", [["ano", "Áno"], ["nie", "Nie"], ["neviem", "Neviem"]]),
    q("n_edem", "Mali ste opakovane náhlu dýchavicu s vodou na pľúcach alebo náhle zlyhanie srdca?", YN),
    q("n_zakrok", "Odporučil vám lekár zákrok (rozšírenie tepny, stent)?", YN),
  ] },
  { id: "prsty", label: "Studené, biele alebo modré prsty", questions: [
    q("p_rany", "Máte na prstoch ranky, vredíky alebo trvalo modré či čierne miesto?", YN),
    q("p_jedna", "Týka sa to len jednej ruky alebo nohy?", YN),
  ] },
  { id: "malformacia", label: "Cievna malformácia (AVM, žilová malformácia)", questions: [
    q("m_diag", "Je malformácia potvrdená vyšetrením (ultrazvuk, MR, CT)?", [["ano", "Áno"], ["nie", "Nie, je to len podozrenie"]]),
    q("m_kde", "Kde sa nachádza?", [["koncatina", "Ruka alebo noha"], ["hlava", "Tvár, hlava alebo krk"], ["trup", "Trup alebo panva"], ["organy", "Vnútorné orgány (pľúca, pečeň, obličky…)"], ["mozog", "Mozog alebo miecha"], ["neviem", "Neviem"]]),
    q("m_tazkosti", "Čo vás trápi?", [["krvacanie", "Krvácanie alebo rana, ktorá sa nehojí"], ["bolest", "Bolesť alebo opuch"], ["rast", "Zväčšuje sa alebo sa mení"], ["nic", "Bez ťažkostí — chcem posúdenie"]]),
    q("m_liecba", "Bola už liečená (embolizácia, skleroterapia, operácia)?", YN),
  ] },
  { id: "panva", label: "Dlhodobá bolesť v podbrušku, kŕčové žily v oblasti panvy (panvová kongescia)", questions: [
    q("pk_bolest", "Máte dlhšie ako 6 mesiacov bolesť alebo tlak v podbrušku, ktoré sa zhoršujú pri státí, večer alebo po styku?", YN),
    q("pk_varixy", "Máte kŕčové žily na vonkajších rodidlách, v slabinách, na zadku alebo na zadnej strane stehien?", YN),
    q("pk_gyn", "Boli ste s tým u gynekológa?", [["nie", "Nie"], ["bez", "Áno, inú príčinu nenašiel"], ["ina", "Áno, našla sa iná príčina (napr. endometrióza, myómy)"]]),
    q("pk_nalez", "Máte nález o rozšírených panvových alebo ovariálnych žilách (ultrazvuk, CT, MR)?", YN),
    q("pk_zakrok", "Odporučil vám lekár zákrok (embolizáciu)?", YN),
  ] },
  { id: "po_zakroku", label: "Nové ťažkosti po zákroku na cievach (stent, bypass, operácia žíl)", questions: [
    q("z_typ", "Aký zákrok ste mali?", [["tepny_nohy", "Stent alebo angioplastika tepien nôh"], ["bypass", "Bypass"], ["karotidy", "Zákrok na krčných tepnách"],
      ["aorta", "Stentgraft alebo operácia aorty"], ["zily", "Zákrok na žilách (RFA, laser, operácia)"], ["iny", "Iný"]]),
    q("z_kde", "Kde bol zákrok robený?", [["nusch", "V NÚSCH"], ["inde", "Inde"]]),
    q("z_tazkosti", "Čo vás trápi teraz?", [["pokoj", "Bolesť v pokoji alebo rana"], ["navrat", "Vrátila sa bolesť pri chôdzi / zhoršenie"], ["miesto", "Opuch alebo bolesť v mieste zákroku"], ["kontrola", "Bez ťažkostí — chcem kontrolu"]]),
  ] },
  { id: "ine", label: "Niečo iné", questions: [] },
];

export const REGIONS = ["Bratislavský", "Trnavský", "Trenčiansky", "Nitriansky", "Žilinský", "Banskobystrický", "Prešovský", "Košický", "Mimo Slovenska"];
export const topicById = (id) => TOPICS.find((t) => t.id === id) || null;

// ---------- zaradenie ----------
// request: { topic, answers: { otázka: hodnota }, flags: [id akútnych príznakov], note, birthYear }
export function classify(request) {
  const a = request?.answers || {};
  const flags = Array.isArray(request?.flags) ? request.flags.filter((f) => RED_FLAGS.some((r) => r.id === f)) : [];
  const yes = (k) => a[k] === "ano";
  const is = (k, ...vals) => vals.includes(a[k]);
  const reasons = [];
  let category = "posudit", priority = 2, assigned = false;
  // prvé pravidlo zaradí; ďalšie môžu zaradenie len sprísniť (vyššia kategória,
  // v rovnakej kategórii vyššia priorita). Dôvody sa zbierajú všetky.
  const rank = (c) => CATEGORY_ORDER.indexOf(c);
  const put = (c, p, why) => {
    if (why) reasons.push(why);
    if (!assigned || rank(c) < rank(category) || (c === category && p < priority)) { category = c; priority = p; assigned = true; }
  };
  const info = (why) => { if (why) reasons.push(why); };

  switch (request?.topic) {
    case "varixy": {
      if (is("v_typ", "vred")) put("ustav", 1, "vred pri členku (venózny vred)");
      else if (is("v_typ", "koza")) put("ustav", 2, "kŕčové žily s kožnými zmenami");
      else if (is("v_typ", "varixy")) {
        const sympt = yes("v_tazkosti") || yes("v_zapal");
        if (is("v_ciel", "zakrok")) put("ustav", sympt ? 2 : 3, sympt ? "kŕčové žily s ťažkosťami, záujem o zákrok (RFA)" : "kŕčové žily bez ťažkostí, záujem o zákrok (RFA)");
        else if (yes("v_zapal")) put("ustav", 2, "kŕčové žily po zápale povrchových žíl");
        else put("angiolog", sympt ? 2 : 3, sympt ? "kŕčové žily s ťažkosťami, zatiaľ bez záujmu o zákrok" : "kŕčové žily bez ťažkostí");
      } else if (is("v_typ", "metlicky")) put("angiolog", 3, yes("v_tazkosti") ? "metličky s ťažkosťami" : "len metličky (estetický problém)");
      if (yes("v_zapal") && !is("v_typ", "varixy")) info("v minulosti zápal povrchových žíl");
      if (yes("v_usg")) info("má ultrazvuk žíl");
      break;
    }
    case "chodza": {
      const proven = yes("c_nalez") || yes("c_zakrok") || is("c_vysetreny", "angiolog");
      if (is("c_vzdialenost", "pokoj")) put("ustav", 1, "bolesť v pokoji / v noci — možná kritická ischémia");
      else if (is("c_vzdialenost", "do50")) put("ustav", 2, "bolesť pri chôdzi do 50 m");
      else if (is("c_vzdialenost", "50_200")) put(proven ? "ustav" : "angiolog", 2, proven ? "bolesť pri chôdzi 50–200 m, už vyšetrený(á)" : "bolesť pri chôdzi 50–200 m, zatiaľ bez cievneho vyšetrenia");
      else if (is("c_vzdialenost", "nad200")) put(yes("c_nalez") || yes("c_zakrok") ? "ustav" : "angiolog", 3, "bolesť pri chôdzi nad 200 m");
      else if (is("c_vzdialenost", "nesuvisi")) put(yes("c_nalez") ? "angiolog" : "obvodny", 3, "bolesť nesúvisí s chôdzou");
      if (yes("c_zakrok")) put("ustav", 2, "lekár odporučil zákrok na tepnách");
      else if (yes("c_nalez")) info("má nález o zúžení / uzávere tepien");
      if (yes("c_cukrovka")) info("cukrovka");
      if (yes("c_fajcenie")) info("fajčí");
      break;
    }
    case "rana": {
      const risky = is("r_miesto", "prsty", "pata") || yes("r_cukrovka") || yes("r_pokoj") || yes("r_cierne");
      if (yes("r_cierne")) put("ustav", 1, "čierne (odumreté) tkanivo");
      if (yes("r_pokoj")) put("ustav", 1, "rana s bolesťou v pokoji — možná kritická ischémia");
      if (is("r_trvanie", "nad6")) put("ustav", risky ? 1 : 2, "rana trvá viac ako 6 týždňov");
      else if (is("r_trvanie", "2_6")) put("ustav", risky ? 1 : 2, "rana trvá 2–6 týždňov");
      else if (is("r_trvanie", "do2")) put(risky ? "ustav" : "obvodny", 2, risky ? "čerstvá rana s rizikom (cukrovka / prsty, päta)" : "čerstvá rana do 2 týždňov, bez rizikových znakov");
      if (is("r_miesto", "prsty", "pata")) info(is("r_miesto", "pata") ? "rana na päte" : "rana na prstoch / prednej časti chodidla");
      if (is("r_miesto", "clenok")) info("rana pri členku / na predkolení (často žilový pôvod)");
      if (yes("r_cukrovka")) info("cukrovka");
      break;
    }
    case "opuch": {
      if (is("o_strana", "jedna") && is("o_trvanie", "dni")) put("akutne", 1, yes("o_bolest") ? "náhly bolestivý opuch jednej nohy — vylúčiť trombózu ešte dnes" : "náhly opuch jednej nohy — vylúčiť trombózu");
      else if (is("o_strana", "jedna")) put(yes("o_po_tromboze") ? "ustav" : "angiolog", 2, yes("o_po_tromboze") ? "dlhodobý opuch nohy po trombóze (posttrombotický syndróm)" : "dlhodobý opuch jednej nohy");
      else if (is("o_strana", "obe")) put(yes("o_po_tromboze") ? "angiolog" : "obvodny", yes("o_bolest") ? 2 : 3, "opuch oboch nôh — najprv vylúčiť celkové príčiny (srdce, obličky, lieky)");
      if (yes("o_bolest") && !is("o_trvanie", "dni")) info("noha bolestivá / teplá / začervenaná");
      break;
    }
    case "tromboza": {
      const deep = !is("t_kde", "povrchove");
      if (is("t_kedy", "teraz")) {
        if (!deep) put("angiolog", 1, "čerstvý zápal povrchových žíl");
        else if (is("t_rozsah", "stehno")) put("ustav", 1, "čerstvá trombóza stehna / panvy — zvážiť katétrovú liečbu");
        else put("angiolog", 1, "čerstvá hlboká trombóza v liečbe");
      } else if (deep && yes("t_tazkosti")) put(is("t_rozsah", "lytko") ? "angiolog" : "ustav", 2, is("t_rozsah", "lytko") ? "ťažkosti po trombóze lýtka" : "pretrvávajúce ťažkosti po trombóze (posttrombotický syndróm)");
      else if (is("t_kedy", "davno") && !yes("t_lieky") && !yes("t_tazkosti")) put("obvodny", 3, "dávna trombóza bez ťažkostí a bez liečby");
      else put("angiolog", 3, deep ? "stav po trombóze — sledovanie, dĺžka liečby" : "stav po zápale povrchových žíl");
      if (yes("t_lieky")) info("užíva lieky na riedenie krvi");
      break;
    }
    case "karotidy": {
      if (yes("k_prihoda") && !is("k_stupen", "do50", "uzaver")) put("ustav", 1, "zúženie karotídy s príznakmi za posledných 6 mesiacov");
      else if (is("k_stupen", "nad70")) put("ustav", 2, "zúženie karotídy 70 % a viac");
      else if (is("k_stupen", "50_69")) put("angiolog", 2, "zúženie karotídy 50–69 % bez príznakov — sledovanie");
      else if (is("k_stupen", "do50")) put("angiolog", 3, "zúženie karotídy menej ako 50 %");
      else if (is("k_stupen", "uzaver")) put("angiolog", 2, "uzáver karotídy");
      else if (is("k_stupen", "neviem")) put("angiolog", 2, "zúženie karotídy neznámeho stupňa — potrebný ultrazvuk");
      if (yes("k_zakrok")) put("ustav", 2, "lekár odporučil zákrok na karotíde");
      if (yes("k_prihoda") && is("k_stupen", "do50", "uzaver")) info("mozgová príhoda / TIA za posledných 6 mesiacov");
      break;
    }
    case "aneuryzma": {
      if (is("a_kde", "koncatina")) put("ustav", 2, "aneuryzma tepny v podkolení / stehne");
      else if (is("a_velkost", "nad5")) put("ustav", 1, "aneuryzma 5 cm a viac");
      else if (is("a_velkost", "4_49")) put("ustav", 2, "aneuryzma 4–4,9 cm");
      else if (is("a_velkost", "do4")) put("angiolog", 3, "malá aneuryzma (menej ako 4 cm) — sledovanie");
      else if (is("a_velkost", "neviem")) put("angiolog", 2, "aneuryzma neznámej veľkosti");
      if (is("a_rast", "ano")) put("ustav", 2, "aneuryzma sa za rok zväčšila");
      if (yes("a_zakrok")) put("ustav", 2, "lekár odporučil zákrok");
      if (is("a_kde", "hrudna")) info("hrudná aorta");
      break;
    }
    case "renalne": {
      const sympt = yes("n_tlak") || yes("n_oblicky");
      if (yes("n_edem") && !is("n_nalez", "nie")) put("ustav", 1, "zúženie renálnej tepny s opakovaným pľúcnym edémom / zlyhaním srdca");
      else if (is("n_nalez", "nad70")) put("ustav", sympt ? 2 : 3, sympt ? "významné zúženie renálnej tepny s ťažko liečiteľným tlakom / zhoršovaním obličiek" : "významné zúženie renálnej tepny bez ťažkostí");
      else if (is("n_nalez", "do70")) put("angiolog", sympt ? 2 : 3, sympt ? "menej významné zúženie renálnej tepny s ťažko liečiteľným tlakom / zhoršovaním obličiek — doplniť vyšetrenie" : "menej významné zúženie renálnej tepny — sledovanie");
      else if (is("n_nalez", "nie")) put("obvodny", 3, sympt || yes("n_edem") ? "ťažko liečiteľný tlak bez vyšetrenia renálnych tepien — najprv internista / kardiológ" : "bez nálezu na renálnych tepnách");
      if (yes("n_zakrok")) put("ustav", 2, "lekár odporučil zákrok na renálnej tepne");
      if (yes("n_tlak")) info("tlak neupravený na 3 a viac liekoch");
      if (yes("n_oblicky")) info("zhoršovanie funkcie obličiek");
      break;
    }
    case "malformacia": {
      const confirmed = yes("m_diag"), active = is("m_tazkosti", "bolest", "rast");
      if (is("m_kde", "mozog")) put("posudit", 3, "malformácia mozgu / miechy — patrí neurochirurgii / intervenčnej neurorádiológii");
      else if (is("m_tazkosti", "krvacanie")) put("ustav", 1, "cievna malformácia s krvácaním alebo nehojacou sa ranou");
      else if (confirmed) put("ustav", active || is("m_kde", "organy") ? 2 : 3, active ? "potvrdená cievna malformácia s ťažkosťami (bolesť / opuch / rast)" : is("m_kde", "organy") ? "potvrdená malformácia vnútorných orgánov" : "potvrdená cievna malformácia bez ťažkostí — posúdenie");
      else if (is("m_diag", "nie")) put("angiolog", active ? 2 : 3, "podozrenie na cievnu malformáciu — najprv ultrazvuk");
      if (yes("m_liecba")) { if (!is("m_kde", "mozog") && !is("m_tazkosti", "nic")) put("ustav", 2, "ťažkosti po predchádzajúcej liečbe malformácie"); else info("malformácia už bola liečená"); }
      if (is("m_kde", "hlava")) info("lokalizácia: tvár / hlava / krk");
      break;
    }
    case "panva": {
      if (yes("pk_zakrok")) put("ustav", 2, "lekár odporučil embolizáciu panvových žíl");
      else if (yes("pk_nalez")) put("ustav", 2, "nález rozšírených panvových / ovariálnych žíl");
      else if (yes("pk_bolest") && is("pk_gyn", "bez")) put("ustav", yes("pk_varixy") ? 2 : 3, yes("pk_varixy") ? "typické príznaky panvovej kongescie, gynekológ inú príčinu nenašiel" : "chronická panvová bolesť, gynekológ inú príčinu nenašiel — vylúčiť panvovú kongesciu");
      else if (is("pk_gyn", "ina")) put("posudit", 3, "panvová bolesť s inou gynekologickou príčinou — pravdepodobne nie cievny problém");
      else if (yes("pk_bolest")) put("posudit", 3, "chronická panvová bolesť bez gynekologického vyšetrenia — najprv gynekológ");
      else if (yes("pk_varixy")) put("ustav", 3, "kŕčové žily v atypickej lokalizácii (rodidlá, slabiny, zadok) — možný panvový reflux");
      else put("posudit", 3, "bez typických príznakov panvovej kongescie — prečítať text");
      if (yes("pk_varixy") && (yes("pk_zakrok") || yes("pk_nalez") || is("pk_gyn", "ina") || (yes("pk_bolest") && !is("pk_gyn", "bez")))) info("kŕčové žily v oblasti rodidiel / slabín / zadku");
      break;
    }
    case "prsty": {
      if (yes("p_rany")) put("ustav", 2, "ranky / trvalá zmena farby na prstoch");
      else if (yes("p_jedna")) put("angiolog", 2, "príznaky len na jednej končatine — vylúčiť tepnovú príčinu");
      else put("angiolog", 3, "studené / biele prsty bez rán (Raynaudov fenomén)");
      break;
    }
    case "po_zakroku": {
      if (is("z_tazkosti", "pokoj")) put("ustav", 1, "po zákroku: bolesť v pokoji alebo rana");
      else if (is("z_tazkosti", "navrat")) put("ustav", 2, "po zákroku: návrat ťažkostí");
      else if (is("z_tazkosti", "miesto")) put("ustav", 2, "po zákroku: opuch / bolesť v mieste zákroku");
      else if (is("z_tazkosti", "kontrola")) put(is("z_kde", "nusch") ? "ustav" : "angiolog", 3, is("z_kde", "nusch") ? "kontrola po zákroku v NÚSCH" : "kontrola po zákroku na inom pracovisku");
      if (is("z_kde", "nusch") && !is("z_tazkosti", "kontrola")) info("zákrok robený v NÚSCH");
      break;
    }
    default: break; // „ine" alebo neznáma téma → na posúdenie
  }

  // akútne príznaky zaškrtnuté pacientom majú vždy prednosť
  if (flags.length) {
    category = "akutne"; priority = 1;
    reasons.unshift(...flags.map((f) => `pacient označil: ${RED_FLAGS.find((r) => r.id === f).short}`));
  }
  if (reasons.length === 0) reasons.push(request?.topic === "ine" || !request?.topic ? "voľný popis — prečítať text" : "neúplné odpovede — prečítať text");
  return { category, priority, reasons, call155: flags.some((f) => RED_FLAGS.find((r) => r.id === f).call155) };
}

// poradie v prehľade: kategória, priorita, potom najstaršie
export const triageSort = (x, y) =>
  CATEGORY_ORDER.indexOf(x.triage.category) - CATEGORY_ORDER.indexOf(y.triage.category)
  || x.triage.priority - y.triage.priority
  || String(x.createdAt).localeCompare(String(y.createdAt));

// čitateľný výpis odpovedí: [[otázka, odpoveď], …]
export function summarize(request) {
  const t = topicById(request?.topic);
  const a = request?.answers || {};
  if (!t) return [];
  return t.questions.filter((qq) => a[qq.id]).map((qq) => [qq.label, qq.options.find((o) => o.value === a[qq.id])?.label || String(a[qq.id])]);
}

// ---------- pravidlá slovom (zobrazené lekárovi v správe; držať zhodne s classify) ----------
export const RULES_OVERVIEW = [
  { category: "akutne", title: "Akútne — pacient dostane pokyn hneď na obrazovke", items: [
    "zaškrtol niektorý z akútnych príznakov (náhle studená / bledá končatina s bolesťou, dýchavica alebo bolesť na hrudi, príznaky mozgovej príhody, prudká bolesť pri známej aneuryzme, náhly bolestivý opuch jednej nohy, rana s infekciou alebo černaním)",
    "náhly opuch jednej nohy za posledné dni (téma Opuch)",
  ] },
  { category: "ustav", title: "Ústav — prednostne", items: [
    "vred pri členku pri kŕčových žilách",
    "bolesť nôh v pokoji alebo v noci",
    "rana: čierne tkanivo, bolesť v pokoji, alebo rana dlhšie ako 2 týždne s rizikom (cukrovka, prsty, päta)",
    "čerstvá trombóza stehna alebo panvy (do 4 týždňov)",
    "zúženie karotídy s príznakmi za posledných 6 mesiacov (okrem zúženia pod 50 % a úplného uzáveru)",
    "aneuryzma aorty 5 cm a viac",
    "po zákroku na cievach: bolesť v pokoji alebo rana",
    "zúženie renálnej tepny s opakovaným pľúcnym edémom alebo náhlym zlyhaním srdca",
    "cievna malformácia (AVM) s krvácaním alebo nehojacou sa ranou",
  ] },
  { category: "ustav", title: "Ústav — bežne", items: [
    "kŕčové žily s kožnými zmenami",
    "kŕčové žily s ťažkosťami a záujmom o zákrok (RFA / laser, skleroterapia, operácia)",
    "kŕčové žily po zápale povrchových žíl",
    "bolesť pri chôdzi do 50 m",
    "bolesť pri chôdzi 50–200 m, ak už má nález, odporúčaný zákrok alebo bol u angiológa",
    "lekár odporučil zákrok (tepny nôh, karotída, aneuryzma)",
    "rana dlhšie ako 2 týždne bez rizikových znakov; čerstvá rana s rizikom",
    "dlhodobý opuch jednej nohy po trombóze",
    "pretrvávajúce ťažkosti po trombóze stehna alebo panvy",
    "zúženie karotídy 70 % a viac bez príznakov",
    "aneuryzma 4–4,9 cm, aneuryzma, ktorá rastie, aneuryzma tepny v podkolení alebo v stehne",
    "ranky alebo trvalá zmena farby na prstoch",
    "po zákroku: návrat ťažkostí, opuch alebo bolesť v mieste zákroku",
    "významné zúženie renálnej tepny (70 % a viac) s tlakom neupraveným na 3 liekoch alebo so zhoršovaním obličiek; odporúčaný zákrok na renálnej tepne",
    "potvrdená cievna malformácia s bolesťou, opuchom alebo rastom; malformácia vnútorných orgánov; ťažkosti po predchádzajúcej liečbe malformácie",
    "panvová kongescia: odporúčaná embolizácia, nález rozšírených panvových / ovariálnych žíl, alebo typické príznaky (bolesť + atypické kŕčové žily) po gynekologickom vyšetrení bez inej príčiny",
  ] },
  { category: "ustav", title: "Ústav — nízka priorita", items: [
    "kŕčové žily bez ťažkostí, ale so záujmom o zákrok",
    "bolesť pri chôdzi nad 200 m s nálezom alebo odporúčaným zákrokom",
    "kontrola po zákroku v NÚSCH bez ťažkostí",
    "významné zúženie renálnej tepny bez ťažkostí",
    "potvrdená cievna malformácia bez ťažkostí (posúdenie)",
    "chronická panvová bolesť bez atypických kŕčových žíl, gynekológ inú príčinu nenašiel; kŕčové žily na rodidlách, v slabinách alebo na zadku bez bolesti",
  ] },
  { category: "angiolog", title: "Rajónny angiológ", items: [
    "kŕčové žily bez záujmu o zákrok; metličky",
    "bolesť pri chôdzi 50–200 m bez cievneho vyšetrenia; nad 200 m bez nálezu",
    "bolesť nesúvisiaca s chôdzou, ak má nález na tepnách",
    "dlhodobý opuch jednej nohy bez trombózy v minulosti; opuch oboch nôh po trombóze",
    "čerstvá trombóza lýtka alebo zápal povrchových žíl (prednostne); stav po trombóze — sledovanie; ťažkosti po trombóze lýtka",
    "karotídy: zúženie pod 50 %, 50–69 % bez príznakov, uzáver, neznámy stupeň",
    "aneuryzma menšia ako 4 cm alebo neznámej veľkosti",
    "studené / biele prsty bez rán (Raynaud); príznaky len na jednej končatine",
    "kontrola po zákroku na inom pracovisku bez ťažkostí",
    "menej významné zúženie renálnej tepny (s ťažkosťami bežne, bez nich nízka priorita)",
    "podozrenie na cievnu malformáciu bez potvrdenia vyšetrením — najprv ultrazvuk",
  ] },
  { category: "obvodny", title: "Obvodný lekár", items: [
    "bolesť nôh nesúvisiaca s chôdzou, bez nálezu na tepnách",
    "čerstvá rana do 2 týždňov bez rizikových znakov",
    "opuch oboch nôh bez trombózy v minulosti (najprv srdce, obličky, lieky)",
    "trombóza pred viac ako rokom, bez ťažkostí a bez liekov na riedenie krvi",
    "ťažko liečiteľný tlak bez nálezu na renálnych tepnách (najprv internista / kardiológ)",
  ] },
  { category: "posudit", title: "Na posúdenie — prečítať text", items: [
    "téma „Niečo iné“ alebo neúplné odpovede",
    "patrí inému odborníkovi: malformácia mozgu / miechy (neurochirurgia), chronická panvová bolesť bez gynekologického vyšetrenia alebo s inou gynekologickou príčinou",
  ] },
];

// ---------- téma → vyšetrenie v Angiologickej ambulancii č. 1 (pri „Pozvať k nám") ----------
// id z angio_pricelist; ang_k_* pridáva angio-konzultacie-001.sql, ostatné už v ambulancii sú.
// Ak vyšetrenie v ambulancii nie je aktívne, odkaz vedie na zoznam všetkých vyšetrení.
export const TOPIC_EXAM = {
  varixy: "ang_usg_dk",        // Konzultácia pred RFA
  chodza: "ang_k_tepny",
  rana: "ang_vnwtrvq2",        // Zachráň nohu
  opuch: "ang_k_zily",
  tromboza: "ang_k_zily",
  karotidy: "ang_k_karotidy",
  aneuryzma: "ang_k_aneuryzma",
  renalne: "ang_k_renalne",
  malformacia: "ang_k_avm",
  panva: "ang_prve",           // kompresia ciev v brušnej dutine
  prsty: "ang_pqdggmxd",       // Prvé cievne vyšetrenie
  ine: "ang_pqdggmxd",
};
export function examForRequest(request) {
  if (request?.topic === "po_zakroku") return request?.answers?.z_typ === "zily" ? "ang_konzult" : "ang_usg_krk"; // kontrola po RFA / po výkone
  return TOPIC_EXAM[request?.topic] || "";
}
// odkaz do objednávania (krátka adresa; s vyšetrením ho má pacient rovno vybrané)
export const angioBookingLink = (examId) => `objednanie.cievny.sk/angio1/${examId ? `?v=${examId}` : ""}`;
export const ANGIO_LINK_RE = /objednanie\.cievny\.sk\/(?:angio1\/(?:\?v=[a-z0-9_]+)?|#\/angio1[^\s,;)]*)/g;
export const ustavReply = (examId) => `Ďakujeme za správu. Podľa popisu odporúčame vyšetrenie v našej ambulancii. Objednajte sa na ${angioBookingLink(examId)}${examId ? " — vyšetrenie už bude vybrané" : ""} a prineste doterajšie nálezy.`;

// ---------- šablóny odpovede (lekár ich pred odoslaním upraví) ----------
// SMS ide bez diakritiky; e-mail s diakritikou.
export const REPLY_TEMPLATES = {
  akutne: "Podľa popisu môže ísť o akútny stav. Vyhľadajte, prosím, lekára ešte dnes (pohotovosť alebo urgentný príjem). Pri zhoršení volajte 155.",
  ustav: "Ďakujeme za správu. Podľa popisu odporúčame vyšetrenie v našej ambulancii. Objednajte sa na objednanie.cievny.sk/angio1/ a prineste doterajšie nálezy.",
  angiolog: "Ďakujeme za správu. Podľa popisu odporúčame najprv vyšetrenie u angiológa v mieste bydliska; výmenný lístok vám vystaví všeobecný lekár. Pri zhoršení sa ozvite.",
  obvodny: "Ďakujeme za správu. Podľa popisu odporúčame najprv návštevu všeobecného lekára, ktorý rozhodne o ďalšom postupe.",
  posudit: "Ďakujeme za správu.",
};
export const OUTCOMES = [["ustav", "Pozvať k nám (ústav)"], ["angiolog", "Rajónny angiológ"], ["obvodny", "Obvodný lekár"], ["akutne", "Akútne — ihneď k lekárovi"], ["ine", "Iné"]];
