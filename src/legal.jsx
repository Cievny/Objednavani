// Právne texty — Podmienky online objednávania (VOP) a Informácie
// o spracúvaní osobných údajov. Znenie podľa podkladov z právnej
// prípravy; polia označené [DOPLNIŤ]/[OVERIŤ] sa vyplnia pri schválení.
// Po schválení DPO a právnym oddelením NÚSCH odstrániť DraftBanner
// (a nastaviť dátum účinnosti). Rovnaké znenie je v docs/pravne-posudenie-navrh.md
// (podklad na právne posúdenie) — pri zmene upraviť oboje.

const M = ({ children }) => <mark className="bg-yellow-200 px-1 rounded">{children}</mark>;

const DraftBanner = () => (
  <div className="bg-yellow-50 border-l-4 border-yellow-500 text-yellow-900 text-sm font-semibold p-3 rounded-r-lg mb-5">
    NÁVRH — tento text čaká na schválenie právnym oddelením a zodpovednou osobou (DPO) NÚSCH, a.s.
    Do schválenia nie je právne účinný. Žlto označené miesta sa dopĺňajú.
  </div>
);

const H = ({ children }) => <h3 className="text-base font-bold text-brand mt-5 mb-2">{children}</h3>;
const P = ({ children }) => <p className="text-sm text-slate-700 mb-2 leading-relaxed">{children}</p>;
const LI = ({ children }) => <li className="text-sm text-slate-700 mb-1 leading-relaxed">{children}</li>;
const OL = ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>;
const UL = ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>;

const InfoRow = ({ k, children }) => (
  <div className="grid md:grid-cols-[180px_1fr] gap-1 md:gap-3 py-1.5 border-b border-slate-100 text-sm">
    <div className="font-semibold text-slate-500">{k}</div>
    <div className="text-slate-800">{children}</div>
  </div>
);

const LegalShell = ({ title, children }) => (
  <div className="bg-white rounded-xl border border-line p-6 md:p-8">
    <DraftBanner />
    <h2 className="text-xl md:text-2xl font-semibold text-brand mb-1">{title}</h2>
    <p className="text-xs text-slate-400 mb-4">objednanie.cievny.sk · Národný ústav srdcových a cievnych chorôb, a.s.</p>
    {children}
    <p className="text-xs text-slate-400 mt-6">
      <a href="#/" className="text-brand font-semibold hover:underline"
        onClick={(e) => { if (window.history.length > 1) { e.preventDefault(); window.history.back(); } }}>‹ Späť na objednávanie</a>
    </p>
  </div>
);

// Potvrdenie oboznámenia s podmienkami a informáciami o osobných údajoch
// (informačná povinnosť čl. 13 GDPR; právny základ nie je súhlas, preto
// „oboznámil/a som sa", nie „súhlasím"). Používa sa v angio a CT formulári.
export function ConsentAck({ checked, onChange, error, testId = "consent-ack" }) {
  return (
    <div className={error ? "border border-red-300 bg-red-50 rounded-lg p-3" : "border border-slate-200 bg-page rounded-lg p-3"}>
      <label className="flex items-start gap-3 cursor-pointer text-sm text-slate-700 leading-relaxed">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId}
          aria-invalid={error ? "true" : undefined} className="mt-1 h-5 w-5 shrink-0 accent-brand" />
        <span>
          Oboznámil/a som sa s{" "}
          <a href="#/podmienky" target="_blank" rel="noopener" className="text-brand font-semibold underline underline-offset-2">Podmienkami online objednávania</a>{" "}
          a s{" "}
          <a href="#/osobne-udaje" target="_blank" rel="noopener" className="text-brand font-semibold underline underline-offset-2">Informáciami o spracúvaní osobných údajov</a>. *
          <span className="block text-xs text-slate-500 mt-1">Ak objednávate inú osobu, potvrdzujete, že konáte s jej vedomím.</span>
        </span>
      </label>
      {error && <p className="text-xs text-red-600 mt-1" role="alert">{error}</p>}
    </div>
  );
}

export const VopPage = () => (
  <LegalShell title="Podmienky online objednávania">
    <H>Článok I — Poskytovateľ</H>
    <P>Poskytovateľom zdravotnej starostlivosti a zmluvnou stranou pacienta je:</P>
    <div className="mb-2">
      <InfoRow k="Obchodné meno">Národný ústav srdcových a cievnych chorôb, a. s.</InfoRow>
      <InfoRow k="Sídlo">Pod Krásnou hôrkou 1, 833 48 Bratislava</InfoRow>
      <InfoRow k="IČO">35 971 126</InfoRow>
      <InfoRow k="Registrácia">Obchodný register Mestského súdu Bratislava III, oddiel Sa, vložka č. 3774/B</InfoRow>
      <InfoRow k="Pracovisko">Špecializované sonografické pracovisko NÚSCH, a. s.</InfoRow>
      <InfoRow k="Kontakt pre objednávky">SMS na 0949 000 677 (uveďte číslo objednávky) · e-mail <M>[DOPLNIŤ oficiálny e-mail]</M></InfoRow>
    </div>
    <P>
      Objednávkový systém technicky prevádzkuje spoločnosť FiveV s. r. o., Hrudky 4318/63, 900 25 Chorvátsky Grob,
      IČO 56 516 711, ako sprostredkovateľ poskytovateľa; technická prevádzka systému nezakladá zmluvný vzťah medzi
      pacientom a touto spoločnosťou. (ďalej len „poskytovateľ" a „pracovisko")
    </P>

    <H>Článok II — Predmet a povaha zmluvy</H>
    <OL>
      <LI>Tieto podmienky upravujú online objednávanie prostredníctvom webovej stránky objednanie.cievny.sk (vrátane vstupov objednanie.cievny.sk/zachrannohu a zachrannohu.sk): a) rezerváciu termínu a úhradu ceny ultrasonografických (USG) vyšetrení poskytovaných v doplnkových ordinačných hodinách (články III až VIII), b) objednávanie na vyšetrenia v angiologickej ambulancii a na CT pracovisku poskytované bez poplatku v rámci verejného zdravotného poistenia (článok IX) a c) žiadosť o spätné zavolanie (článok X).</LI>
      <LI>USG vyšetrenia podľa písm. a) sa poskytujú ako výkony uhrádzané pacientom podľa platného cenníka (samoplatca), alebo s doplatkom pri predložení žiadanky od lekára, ak to cenník pri danom vyšetrení umožňuje.</LI>
      <LI>Odoslanie online objednávky je návrhom na uzavretie zmluvy o poskytnutí zdravotnej starostlivosti, resp. služieb súvisiacich s jej poskytovaním. Zmluva vzniká potvrdením termínu zo strany pracoviska po pripísaní platby; o potvrdení je pacient informovaný e-mailom, prípadne SMS.</LI>
      <LI>Zmluva sa uzatvára v slovenskom jazyku. Údaje objednávky môže pacient pred jej odoslaním skontrolovať a opraviť. Objednávka je u poskytovateľa evidovaná po dobu uvedenú v dokumente <a href="#/osobne-udaje" className="text-brand font-semibold hover:underline">Informácie o spracúvaní osobných údajov</a>.</LI>
    </OL>

    <H>Článok III — Objednávka a rezervácia termínu</H>
    <OL>
      <LI>Pacient si v systéme vyberie typ vyšetrenia a voľný termín a vyplní požadované údaje (meno a priezvisko, dátum narodenia, telefón, e-mail, dôvod vyšetrenia; pri vyšetrení so žiadankou aj údaje odporúčajúceho lekára a prílohy).</LI>
      <LI>Odoslaním objednávky vzniká rezervácia termínu. Rezervácia sa stáva záväznou až po pripísaní platby a potvrdení pracoviskom.</LI>
      <LI>Ak platba nie je pripísaná do 3 pracovných dní od odoslania objednávky, najneskôr však 24 hodín pred termínom, pracovisko je oprávnené rezerváciu zrušiť a termín uvoľniť.</LI>
      <LI>Pracovisko si vyhradzuje právo objednávku odmietnuť alebo termín presunúť z prevádzkových alebo medicínskych dôvodov; v takom prípade pacientovi vráti prijatú platbu v plnej výške alebo mu ponúkne náhradný termín podľa jeho voľby.</LI>
      <LI>Ak objednávku vykonáva iná osoba než pacient, odoslaním objednávky vyhlasuje, že je zákonným zástupcom pacienta alebo koná s jeho vedomím a súhlasom. Zmluvnou stranou zmluvy o poskytnutí zdravotnej starostlivosti je pacient.</LI>
      <LI>Pacient je povinný uvádzať v objednávke pravdivé a úplné údaje. Ak nepravdivé alebo neúplné údaje znemožnia riadne poskytnutie vyšetrenia, pracovisko je oprávnené vyšetrenie nevykonať; úhrada sa v takom prípade posudzuje podľa článku V.</LI>
      <LI>Na ochranu pred zneužitím systému a blokovaním kapacity možno na jedno telefónne číslo evidovať najviac 3 aktívne objednávky súčasne. Ak pacient potrebuje viac termínov, kontaktuje pracovisko SMS správou na čísle 0949 000 677.</LI>
      <LI>Systém ponúka termíny postupne od začiatku otvorených ordinačných blokov tak, aby vyšetrenia nadväzovali; po obsadení ponúkaného času sa automaticky sprístupní nasledujúci.</LI>
    </OL>

    <H>Článok IV — Cena a platba</H>
    <OL>
      <LI>Ceny vyšetrení sa riadia platným cenníkom poskytovateľa zverejneným na stránke objednávania. Rozhodujúca je cena platná v čase odoslania objednávky, uvedená v objednávke a v potvrdzujúcom e-maile.</LI>
      <LI>Termíny ponúkané v tomto systéme sú poskytované v doplnkových ordinačných hodinách poskytovateľa podľa zákona č. 576/2004 Z. z. a zákona č. 577/2004 Z. z., schválených príslušným samosprávnym krajom. Cenník je schválený a zverejnený na stránke objednávania aj v priestoroch pracoviska.</LI>
      <LI>Pri vyšetrení so žiadankou od lekára hradí pacient doplatok za poskytnutie vyšetrenia v doplnkových ordinačných hodinách podľa cenníka. Nejde o spoplatnenie zdravotnej starostlivosti plne hradenej z verejného zdravotného poistenia — vyšetrenie v riadnych ordinačných hodinách zostáva pacientovi so žiadankou naďalej dostupné bezplatne cestou štandardného objednania u poskytovateľa. Originál žiadanky (výmenného lístka) je pacient povinný predložiť pri vyšetrení; bez jej predloženia je pracovisko oprávnené účtovať plnú cenu samoplatcu alebo vyšetrenie nevykonať.</LI>
      <LI>Platba sa realizuje bezhotovostne prevodom alebo QR kódom (PAY by square) na účet IBAN <M>[DOPLNIŤ účet NÚSCH]</M> s variabilným symbolom prideleným pri objednávke. Platba sa považuje za uhradenú okamihom pripísania na účet.</LI>
      <LI>Po pripísaní platby poskytovateľ automaticky vystaví faktúru (doklad o zaplatení) a doručí ju pacientovi e-mailom na adresu uvedenú v objednávke. Pri vrátení platby sa k faktúre vystaví a rovnakým spôsobom doručí dobropis. Doklady neobsahujú žiadne údaje o zdravotnom stave.</LI>
    </OL>

    <H>Článok V — Zmena a zrušenie termínu, storno podmienky</H>
    <OL>
      <LI>Pacient môže objednávku zrušiť online najneskôr 48 hodín pred termínom, a to cez odkaz „Spravovať alebo zrušiť objednávku" v ktoromkoľvek e-maile o objednávke alebo v sekcii „Už máte objednávku?" na stránke objednávania (zadaním čísla objednávky a telefónneho čísla). Menej ako 48 hodín pred termínom je zrušenie možné už len SMS správou na čísle 0949 000 677 s uvedením čísla objednávky.</LI>
      <LI>Pri zrušení najneskôr 48 hodín pred termínom sa uhradená platba vracia v plnej výške na účet, z ktorého bola prijatá, do 7 pracovných dní od zrušenia.</LI>
      <LI>Pri zrušení menej ako 48 hodín pred termínom alebo pri nedostavení sa na vyšetrenie uhradená platba prepadá v prospech poskytovateľa ako storno poplatok zodpovedajúci rezervovanej kapacite pracoviska.</LI>
      <LI>Ak pacient preukáže, že zrušenie alebo nedostavenie sa spôsobili vážne dôvody hodné osobitného zreteľa (najmä náhle ochorenie alebo hospitalizácia), pracovisko mu namiesto uplatnenia storno poplatku ponúkne náhradný termín.</LI>
      <LI>Ak termín zruší alebo presunie pracovisko, pacient má vždy právo na vrátenie platby v plnej výške alebo na náhradný termín podľa vlastnej voľby. O presune termínu je pacient informovaný e-mailom a SMS; ak mu nový termín nevyhovuje, môže objednávku zrušiť podľa ods. 1 s vrátením platby v plnej výške.</LI>
      <LI>Pracovisko môže z prevádzkových dôvodov (najmä práceneschopnosť lekára) zmeniť vyšetrujúceho lekára; termín, čas, rozsah ani cena vyšetrenia sa tým nemenia a pacient je o zmene vopred informovaný e-mailom a SMS. Ak pacient so zmenou nesúhlasí, môže objednávku zrušiť podľa ods. 1 a 2.</LI>
      <LI>Zrušená objednávka sa v systéme uchováva 7 dní od zrušenia; počas tejto lehoty ju pracovisko môže na žiadosť pacienta obnoviť (ak je pôvodný termín ešte voľný), potom sa údaje vymažú.</LI>
    </OL>

    <H>Článok VI — Odstúpenie od zmluvy (platené USG vyšetrenia)</H>
    <OL>
      <LI>Zdravotná starostlivosť poskytovaná pacientom zdravotníckymi pracovníkmi je vyňatá z pôsobnosti právnej úpravy zmlúv uzavretých na diaľku podľa zákona č. 108/2024 Z. z. o ochrane spotrebiteľa <M>[OVERIŤ presné ustanovenie s právnym oddelením — čl. 3 ods. 3 písm. b) smernice 2011/83/EÚ]</M>. Na objednané vyšetrenie sa preto nevzťahuje zákonné právo odstúpiť od zmluvy do 14 dní bez uvedenia dôvodu.</LI>
      <LI>Možnosti zrušenia objednávky a podmienky vrátenia platby upravuje článok V týchto podmienok.</LI>
    </OL>

    <H>Článok VII — Práva a povinnosti pacienta</H>
    <OL>
      <LI>Pacient sa dostaví 15 minút pred termínom a riadi sa pokynmi pracoviska a prípravou na vyšetrenie uvedenou v potvrdzujúcom e-maile.</LI>
      <LI>Pri vyšetrení pacient predloží doklad totožnosti, preukaz poistenca a pri vyšetrení so žiadankou originál žiadanky.</LI>
      <LI>Meškanie pacienta dlhšie ako 15 minút sa môže považovať za nedostavenie sa na termín s následkami podľa článku V ods. 3 a 4.</LI>
    </OL>

    <H>Článok VIII — Reklamácie, sťažnosti a dohľad</H>
    <OL>
      <LI>Reklamácie súvisiace s objednávaním a platbou vybavuje pracovisko na adrese <M>[DOPLNIŤ oficiálny reklamačný kontakt]</M>; lehota na vybavenie je 30 dní od doručenia.</LI>
      <LI>Podnety týkajúce sa poskytnutej zdravotnej starostlivosti možno podať poskytovateľovi postupom podľa § 17 zákona č. 576/2004 Z. z. Dohľad nad poskytovaním zdravotnej starostlivosti vykonáva Úrad pre dohľad nad zdravotnou starostlivosťou, Žellova 2, 829 24 Bratislava (udzs-sk.sk).</LI>
      <LI>Dozor nad spotrebiteľskými aspektmi online objednávania a platieb vykonáva Slovenská obchodná inšpekcia, Inšpektorát SOI pre Bratislavský kraj, Bajkalská 21/A, 820 07 Bratislava (soi.sk).</LI>
      <LI>Možnosť obrátiť sa na subjekt alternatívneho riešenia sporov podľa zákona č. 391/2015 Z. z. <M>[OVERIŤ aplikovateľnosť na zdravotné výkony s právnym oddelením; v prípade neaplikovateľnosti odsek vypustiť]</M>.</LI>
    </OL>

    <H>Článok IX — Objednávanie na vyšetrenia bez poplatku (angiologická ambulancia, CT pracovisko)</H>
    <OL>
      <LI>Prostredníctvom stránky sa možno objednať aj na vyšetrenia v Angiologickej ambulancii č. 1 a na CT pracovisku poskytovateľa. Tieto vyšetrenia sú zdravotnou starostlivosťou hradenou z verejného zdravotného poistenia; pacient za objednanie ani za vyšetrenie neplatí žiadny poplatok a články IV až VI sa na ne nevzťahujú.</LI>
      <LI>Pri niektorých vyšetreniach je podmienkou žiadanka (výmenný lístok) od lekára; pacient ju pri objednávke priloží (fotografia alebo PDF) a originál predloží pri vyšetrení. Pri vyšetreniach označených „bez žiadanky" (napríklad rýchle zhodnotenie nehojacej sa rany na dolnej končatine v programe Zachráň nohu) žiadanka potrebná nie je; o ďalšom postupe rozhodne lekár pri vyšetrení.</LI>
      <LI>Odoslaním objednávky vzniká rezervácia termínu; potvrdenie je pacientovi doručené e-mailom. Pacient vyplní meno a priezvisko, dátum narodenia, zdravotnú poisťovňu, telefónne číslo, e-mail a podľa potreby dôvod vyšetrenia a prílohy. Telefónne číslo môže byť overené jednorazovým SMS kódom.</LI>
      <LI>Čas termínu je orientačný. Pracovisko je ústavným zariadením najvyššieho typu a musí v niektorých prípadoch prednostne ošetriť akútneho pacienta; o väčšom posune alebo zmene termínu je pacient informovaný e-mailom alebo SMS a môže si zvoliť náhradný termín.</LI>
      <LI>Pacient môže objednávku zmeniť alebo zrušiť online cez odkaz v e-maile alebo v sekcii „Už máte objednávku?" najneskôr 24 hodín pred termínom; neskôr SMS správou na čísle uvedenom v potvrdení. Zrušenie ani nedostavenie sa nie je spojené so žiadnym poplatkom; opakované nedostavenie sa bez ospravedlnenia môže byť dôvodom na odmietnutie ďalšej online objednávky.</LI>
      <LI>Na ochranu kapacity možno na jedno telefónne číslo evidovať obmedzený počet aktívnych objednávok; ďalší termín dohodne pracovisko individuálne.</LI>
      <LI>Objednanie cez stránku nenahrádza neodkladnú zdravotnú starostlivosť. Pri náhlych alebo rýchlo sa zhoršujúcich ťažkostiach (náhla silná bolesť končatiny, bledá alebo studená noha, strata citlivosti alebo hybnosti) je potrebné volať tiesňovú linku 155 alebo 112.</LI>
    </OL>

    <H>Článok X — Žiadosť o spätné zavolanie</H>
    <OL>
      <LI>Pacient, ktorý sa nevie alebo nechce objednať online, môže zanechať meno a telefónne číslo so žiadosťou o spätné zavolanie. Pracovisko zavolá spravidla najneskôr nasledujúci pracovný deň a termín dohodne telefonicky.</LI>
      <LI>Žiadosť o spätné zavolanie nie je objednávkou ani rezerváciou termínu; termín vzniká až dohodou počas hovoru.</LI>
      <LI>Žiadosť môže za pacienta odoslať aj blízka osoba (napríklad rodinný príslušník alebo opatrovateľ). Odoslaním vyhlasuje, že koná s vedomím pacienta a že uvedené telefónne číslo je číslo, na ktorom možno pacienta zastihnúť. Totožnosť pacienta a údaje potrebné na objednanie pracovisko overí priamo s pacientom pri hovore.</LI>
      <LI>Pracovisko môže odmietnuť spätné zavolanie, ak žiadosť zjavne nesúvisí s poskytovaním zdravotnej starostlivosti alebo ak ide o zneužitie služby.</LI>
    </OL>

    <H>Článok XI — Záverečné ustanovenia</H>
    <OL>
      <LI>Spracúvanie osobných údajov upravuje samostatný dokument <a href="#/osobne-udaje" className="text-brand font-semibold hover:underline">Informácie o spracúvaní osobných údajov</a>, dostupný na stránke objednávania.</LI>
      <LI>Poskytovateľ negarantuje nepretržitú dostupnosť objednávkového systému; plánovaná údržba a krátkodobé výpadky nemajú vplyv na už vytvorené objednávky. Ak systém nie je dostupný, objednávku, jej zmenu alebo zrušenie možno vybaviť SMS správou na čísle 0949 000 677.</LI>
      <LI>Tieto podmienky nadobúdajú účinnosť dňom <M>[DOPLNIŤ]</M>. Poskytovateľ ich môže meniť; pre objednávku platí znenie účinné v čase jej odoslania, ktoré je pacientovi dostupné na stránke objednávania.</LI>
      <LI>Právne vzťahy neupravené týmito podmienkami sa spravujú právnym poriadkom Slovenskej republiky, najmä zákonom č. 576/2004 Z. z. a Občianskym zákonníkom.</LI>
    </OL>
  </LegalShell>
);

export const PrivacyPage = () => (
  <LegalShell title="Informácie o spracúvaní osobných údajov">
    <H>Prevádzkovateľ a sprostredkovateľ</H>
    <div className="mb-2">
      <InfoRow k="Prevádzkovateľ">Národný ústav srdcových a cievnych chorôb, a. s., Pod Krásnou hôrkou 1, 833 48 Bratislava, IČO 35 971 126</InfoRow>
      <InfoRow k="Zodpovedná osoba (DPO)"><M>[DOPLNIŤ meno a kontakt DPO NÚSCH]</M></InfoRow>
      <InfoRow k="Kontakt pre dotknuté osoby"><M>[DOPLNIŤ oficiálny kontaktný kanál]</M></InfoRow>
      <InfoRow k="Sprostredkovateľ">
        FiveV s. r. o., Hrudky 4318/63, 900 25 Chorvátsky Grob, IČO 56 516 711, zapísaná v Obchodnom registri Mestského
        súdu Bratislava III, oddiel Sro, vložka č. 181520/B — technická prevádzka objednávkového systému výlučne na
        základe pokynov prevádzkovateľa a zmluvy podľa čl. 28 GDPR.
      </InfoRow>
    </div>

    <H>Aké údaje spracúvame, na aký účel a ako dlho</H>
    <P>Nasledujúce body platia pre všetky online objednávky (USG vyšetrenia, angiologická ambulancia, CT pracovisko), ak nie je uvedené inak. Právnym základom spracúvania nie je súhlas: údaje spracúvame, lebo je to nevyhnutné na objednanie a poskytnutie zdravotnej starostlivosti; zaškrtnutím políčka vo formulári pacient potvrdzuje, že sa s týmito informáciami oboznámil.</P>
    <UL>
      <LI><b>Identifikačné a kontaktné údaje</b> — meno, priezvisko, dátum narodenia, zdravotná poisťovňa, telefónne číslo, e-mailová adresa. Účel: rezervácia termínu, identifikácia pacienta, notifikácie o objednávke. Právny základ: čl. 6 ods. 1 písm. b) GDPR — plnenie zmluvy, resp. opatrenia pred jej uzavretím. Doba uchovávania: po vykonaní vyšetrenia sa údaje z objednávkového systému odstraňujú do 7 dní od jeho uzavretia pracoviskom; najneskôr sa odstraňujú do 28 dní od termínu vyšetrenia.</LI>
      <LI><b>Údaje o zdravotnom stave</b> — typ a dôvod vyšetrenia, údaje zo žiadanky, priložené lekárske správy. Účel: príprava a poskytnutie zdravotnej starostlivosti. Právny základ: čl. 9 ods. 2 písm. h) GDPR v spojení s čl. 6 ods. 1 písm. b) GDPR a so zákonom č. 576/2004 Z. z.; spracúvanie prebieha pod zodpovednosťou osôb viazaných povinnosťou mlčanlivosti. Doba uchovávania: prílohy, dôvod vyšetrenia a údaje zo žiadanky sa z objednávkového systému odstraňujú najneskôr do 7 dní po termíne vyšetrenia; informácia o type vyšetrenia sa odstraňuje spolu s objednávkou (do 7, najneskôr do 28 dní od termínu). Údaje prevzaté do zdravotnej dokumentácie sa uchovávajú mimo tohto systému v lehote podľa zákona č. 576/2004 Z. z. <M>[OVERIŤ presné znenie a plynutie lehoty]</M></LI>
      <LI><b>Zrušené objednávky</b> — úplné údaje objednávky sa po zrušení uchovávajú 7 dní od zrušenia (možnosť obnovenia objednávky na žiadosť pacienta a vybavenie vrátenia platby), potom sa vymazávajú. Účel: správa rezervácií a vrátenie platieb. Právny základ: čl. 6 ods. 1 písm. b) a f) GDPR. Nevyužité objednávky (nedostavenie sa, neuhradenie) sa vymazávajú najneskôr 28 dní od pôvodného termínu.</LI>
      <LI><b>Údaje o úhrade</b> — suma, variabilný symbol, stav platby. Pri automatickom párovaní úhrad načítavame z výpisu bankového účtu prevádzkovateľa údaje o došlých platbách: sumu, menu, variabilný symbol, číslo protiúčtu a správu pre prijímateľa. Účel: párovanie úhrady s objednávkou a vybavenie prípadného vrátenia platby. Právny základ: čl. 6 ods. 1 písm. b) GDPR. Doba uchovávania: záznamy o platbách 90 dní; ostatné údaje sa vymazávajú spolu s objednávkou. Faktúry a dobropisy (účtovné doklady) obsahujú meno a priezvisko pacienta, neutrálny popis úkonu bez akýchkoľvek zdravotných údajov, sumu a platobné údaje; uchovávajú sa oddelene od objednávok po dobu 10 rokov podľa zákona č. 431/2002 Z. z. o účtovníctve (čl. 6 ods. 1 písm. c) GDPR — zákonná povinnosť) a prístup k nim má len poverený správca systému. Banka prevádzkovateľa (Fio banka, a.s., pobočka zahraničnej banky) spracúva platobné údaje ako samostatný prevádzkovateľ podľa vlastných podmienok.</LI>
      <LI><b>Technické a prevádzkové údaje</b> — záznamy o operáciách personálu s objednávkami (auditný log) a technické počítadlá proti zneužitiu systému (počet aktívnych objednávok na telefónne číslo, počet pokusov o overenie objednávky alebo odoslanie formulára z jednej IP adresy). Účel: zabezpečenie a integrita systému, ochrana pred zneužitím a hromadným obsadzovaním termínov, preukázanie prístupov k údajom. Právny základ: čl. 6 ods. 1 písm. f) GDPR — oprávnený záujem na bezpečnosti systému; čl. 32 GDPR. Doba uchovávania: auditný log 90 dní; technické počítadlá (odvodené z IP adresy a telefónneho čísla) najviac 1 hodinu. IP adresy a technické záznamy o prístupe na web spracúvajú okrem toho prevádzkovatelia hostingovej infraštruktúry (GitHub, Supabase) vo svojich systémových logoch.</LI>
      <LI><b>Overenie telefónneho čísla SMS kódom</b> — ak si pracovisko vyžiada overenie, na zadané číslo pošleme jednorazový kód; v systéme sa uchová číslo, odtlačok kódu a čas overenia. Účel: ochrana pred falošnými objednávkami na cudzie číslo. Právny základ: čl. 6 ods. 1 písm. f) GDPR. Doba uchovávania: najviac 1 deň.</LI>
      <LI><b>Údaje odporúčajúceho lekára</b> — meno a pracovisko uvedené v žiadanke. Tieto údaje nezískavame priamo od dotknutej osoby, ale z dokumentácie predloženej pacientom; informácie sa poskytujú podľa čl. 14 GDPR. Účel: overenie indikácie vyšetrenia a komunikácia o výsledku. Právny základ: čl. 6 ods. 1 písm. f) GDPR — oprávnený záujem na overení indikácie. Doba uchovávania: zhodná s dobou uchovávania príslušnej objednávky.</LI>
    </UL>

    <H>Objednávky na angiologickú ambulanciu a CT pracovisko</H>
    <P>Pri týchto objednávkach (vrátane programu Zachráň nohu) spracúvame rovnaké kategórie údajov ako vyššie, s týmito rozdielmi: za vyšetrenie sa neplatí, preto nevznikajú žiadne platobné údaje ani faktúry; súčasťou objednávky môže byť fotografia alebo PDF žiadanky či lekárskej správy (údaje o zdravotnom stave podľa čl. 9 ods. 2 písm. h) GDPR), ktorú pacient nahrá sám. Prílohy a dôvod vyšetrenia sa zo systému odstraňujú ihneď po termíne (ak sa pacient nedostavil alebo bola objednávka zrušená), najneskôr do 7 dní po termíne; celá objednávka sa vymaže najneskôr 28 dní po termíne. Údaje potrebné na zdravotnú dokumentáciu si pracovisko prevezme pri vyšetrení do svojho zdravotníckeho informačného systému, kde sa uchovávajú v lehotách podľa zákona č. 576/2004 Z. z.</P>

    <H>Žiadosť o spätné zavolanie</H>
    <P>Ak nám necháte meno a telefónne číslo so žiadosťou o zavolanie, uchováme ich spolu s údajom, z ktorej stránky žiadosť prišla, a so záznamom o vybavení (kto a kedy volal, stručná poznámka, prípadne číslo vytvorenej objednávky). Účel: dohodnutie termínu vyšetrenia telefonicky. Právny základ: čl. 6 ods. 1 písm. b) GDPR — opatrenia pred uzavretím zmluvy na žiadosť dotknutej osoby, pri zdravotných údajoch uvedených v hovore čl. 9 ods. 2 písm. h) GDPR. Na ochranu pred zneužitím formulára uchovávame 7 dní aj IP adresu, z ktorej bola žiadosť odoslaná (čl. 6 ods. 1 písm. f) GDPR). O novej žiadosti je personál informovaný SMS správou na služobný mobilný telefón a e-mailom na služobnú adresu (meno a telefónne číslo). Žiadosť sa vymaže najneskôr 90 dní od vybavenia; nevybavené žiadosti najneskôr 90 dní od odoslania.</P>
    <P>Ak žiadosť odošle za pacienta iná osoba (napríklad rodinný príslušník), získavame údaje pacienta od tejto osoby; informácie podľa čl. 14 GDPR pacientovi poskytneme pri prvom telefonáte a sú dostupné aj na tejto stránke.</P>

    <H>Upozornenia pre personál</H>
    <P>O každej novej objednávke a o zrušení objednávky pacientom je personál pracoviska informovaný e-mailom na služobné adresy; správa obsahuje meno, dátum narodenia, poisťovňu, kontaktné údaje, typ vyšetrenia, termín a prípadný dôvod vyšetrenia. Tieto správy sa doručujú prostredníctvom sprostredkovateľov uvedených nižšie (Resend, Zoho) a podliehajú rovnakým pravidlám mlčanlivosti ako samotná objednávka.</P>

    <H>Informačná stránka Zachráň nohu</H>
    <P>Orientačný samotest na stránke Zachráň nohu sa vyhodnocuje výlučne vo vašom prehliadači; odpovede sa nikam neodosielajú ani neukladajú. Stránka nepoužíva žiadne analytické ani marketingové nástroje. Obsah stránky má informačný charakter a nenahrádza vyšetrenie lekárom.</P>

    <H>Rodné číslo</H>
    <P>Rodné číslo v objednávkovom formulári nevyžadujeme. Ak je uvedené v priloženej žiadanke alebo v lekárskej správe, spracúvame ho výlučne v rozsahu nevyhnutnom na poskytnutie zdravotnej starostlivosti. Overenie totožnosti prebieha až pri vyšetrení.</P>

    <H>Výmaz údajov, zálohy a štatistika</H>
    <P>Po uplynutí uvedených lehôt sa údaje z prevádzkovej databázy odstraňujú. Zo záložných kópií, ktoré slúžia výlučne na obnovu systému pri poruche, sa údaje odstránia najneskôr do 7 dní; do záložných kópií sa počas tejto doby nezasahuje. Ak dôjde k obnove systému zo zálohy, výmaz údajov po uplynutí lehôt sa vykoná opakovane.</P>
    <P>Na účely riadenia kapacít pracoviska uchovávame anonymné súhrnné údaje (počty objednávok podľa dátumu, typu vyšetrenia a stavu). Tieto údaje neumožňujú identifikáciu konkrétnej osoby a nevzťahuje sa na ne režim ochrany osobných údajov.</P>

    <H>Komu údaje sprístupňujeme</H>
    <P>Údaje sú prístupné poverenému personálu prevádzkovateľa prostredníctvom individuálnych používateľských kont a v rozsahu nevyhnutnom na plnenie pracovných úloh; všetky tieto osoby sú viazané povinnosťou mlčanlivosti.</P>
    <P>Systém technicky zabezpečuje sprostredkovateľ FiveV s. r. o., ktorý na jeho prevádzku využíva týchto ďalších sprostredkovateľov (subdodávateľov):</P>
    <UL>
      <LI>Supabase, Inc. — databáza a úložisko systému; dáta sú uložené v dátovom centre v Európskej únii <M>[OVERIŤ región projektu]</M></LI>
      <LI>Resend (Plus Five Five, Inc., USA) — odosielanie e-mailových notifikácií (e-mailová adresa a obsah notifikácie)</LI>
      <LI>BulkGate (prevádzkovateľ platformy so sídlom v Českej republike <M>[OVERIŤ presné obchodné meno podľa zmluvy/faktúry]</M>) — odosielanie SMS notifikácií pacientom a personálu (telefónne číslo a text SMS vrátane overovacích kódov)</LI>
      <LI>Zoho Corporation — e-mailové schránky domény cievny.sk <M>[OVERIŤ EÚ dátové centrum]</M></LI>
      <LI>GitHub, Inc. — hosting statickej webovej stránky; údaje o pacientoch sa na ňom neuchovávajú, spracúvajú sa technické záznamy vrátane IP adresy</LI>
    </UL>
    <P>Údaje neposkytujeme žiadnym tretím stranám na marketingové účely.</P>

    <H>Prenos do tretej krajiny</H>
    <P>Pri odosielaní e-mailových notifikácií (pacientom aj personálu) dochádza k prenosu e-mailovej adresy a obsahu notifikácie — vrátane mena, termínu a údaja o type vyšetrenia (údaj týkajúci sa zdravia) — do Spojených štátov amerických. Poskytovateľ Resend (Plus Five Five, Inc.) je certifikovaný v rámci EU-U.S. Data Privacy Framework; prenos sa uskutočňuje na základe rozhodnutia Európskej komisie o primeranosti podľa čl. 45 GDPR. Kópiu informácií o uplatnených zárukách poskytneme na požiadanie na kontaktnej adrese uvedenej vyššie. Ostatné spracúvanie prebieha v Európskej únii.</P>

    <H>Cookies a podobné technológie</H>
    <P>Webová stránka používa výlučne technicky nevyhnutné súbory cookie a podobné technológie (vrátane úložiska localStorage prehliadača) potrebné na fungovanie objednávkového formulára a na zabezpečenie prihlásenia personálu. Na ich používanie sa podľa § 109 zákona č. 452/2021 Z. z. o elektronických komunikáciách nevyžaduje súhlas. Analytické ani marketingové nástroje nepoužívame.</P>

    <H>Vaše práva</H>
    <P>Máte právo na prístup k údajom, ich opravu, výmaz, obmedzenie spracúvania, prenosnosť údajov a právo namietať proti spracúvaniu založenému na oprávnenom záujme. Žiadosti vybavujeme do jedného mesiaca od doručenia.</P>
    <P>Vzhľadom na krátke lehoty uchovávania nemusíme byť po výmaze schopní žiadateľa v systéme identifikovať; v takom prípade nemôžeme žiadosti vyhovieť, ak nám dotknutá osoba neposkytne dodatočné identifikačné údaje (čl. 11 ods. 2 GDPR).</P>
    <P>Právo na výmaz je obmedzené pri údajoch, ktoré sme povinní uchovávať podľa osobitných predpisov, najmä pri zdravotnej dokumentácii a účtovných dokladoch.</P>
    <P>Poskytnutie údajov je požiadavkou potrebnou na objednanie a poskytnutie zdravotnej starostlivosti; bez nich nie je možné objednávku ani žiadosť o zavolanie vybaviť. Nedochádza k automatizovanému individuálnemu rozhodovaniu ani k profilovaniu. Údaje detí a osôb pozbavených spôsobilosti zadáva zákonný zástupca.</P>
    <P>Máte právo podať sťažnosť Úradu na ochranu osobných údajov Slovenskej republiky, Hraničná 12, 820 07 Bratislava (dataprotection.gov.sk).</P>
    <P>Účinné od: <M>[DOPLNIŤ dátum zverejnenia]</M></P>
  </LegalShell>
);
