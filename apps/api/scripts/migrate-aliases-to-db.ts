#!/usr/bin/env tsx
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { norm } from "../src/services/equipmentMatcher";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");

// Карта: ключевое слово из AI-ответа → список слов для поиска в каталоге.
// Скопировано из equipmentMatcher.ts (TYPE_SYNONYMS).
const TYPE_SYNONYMS: Record<string, string[]> = {

  // ── COB / Point-source — конкретные модели ─────────────────────────────────
  "xt52":           ["52xt", "electric storm 52", "storm 52"],
  "52xt":           ["52xt", "electric storm 52", "storm 52"],
  "electro storm xt52": ["52xt", "electric storm 52"],
  "storm xt52":     ["52xt", "electric storm 52"],
  "пять два":       ["52xt"],
  "большой шторм":  ["52xt", "electric storm 52"],

  "xt26":           ["26xt", "electric storm 26"],
  "26xt":           ["26xt", "electric storm 26"],
  "electro storm xt26": ["26xt", "electric storm 26"],
  "малый xt":       ["26xt"],

  "cs15":           ["15cs", "electric storm 15"],
  "15cs":           ["15cs", "electric storm 15"],
  "storm cs15":     ["15cs"],
  "пятнашка цветная": ["15cs"],
  "цветной шторм":  ["15cs", "1000c"],

  "1200x":          ["1200x"],
  "ls 1200":        ["1200x"],
  "двенашка икс":   ["1200x"],
  "тысяча двести":  ["1200x"],

  "1000c":          ["1000c"],
  "ls 1000":        ["1000c"],
  "тысячник цветной": ["1000c"],
  "цветная тысяча": ["1000c"],
  "тысячник":       ["1000c", "1200x"],

  "storm 400":      ["400x"],
  "400x":           ["400x"],
  "четырёхсотка":   ["400x"],

  "storm 80":       ["storm 80"],
  "80c":            ["storm 80"],
  "восемьдесятка цветная": ["storm 80"],

  "ls 60":          ["ls 60"],
  "60x":            ["ls 60"],
  "шестидесятка":   ["ls 60", "molus x60"],
  "малый апутур":   ["ls 60", "mc pro"],

  "molus g200":     ["molus g200"],
  "g200":           ["molus g200"],
  "джи двести":     ["molus g200"],
  "двухсотка zhiyun": ["molus g200"],

  "molus g300":     ["molus g300"],
  "g300":           ["molus g300"],
  "трёхсотка zhiyun": ["molus g300"],

  "molus x60":      ["molus x60"],
  "x60":            ["molus x60"],

  "amaran 200":     ["amaran 200"],
  "200x s":         ["amaran 200"],
  "амаран двухсотка": ["amaran 200"],

  "ulanzi vl":      ["ulanzi vl"],
  "vl-200":         ["ulanzi vl"],
  "уланзи двухсотка": ["ulanzi vl"],

  "pixelbrick":     ["pixel brick"],
  "pixel brick":    ["pixel brick"],
  "пиксельбрик":    ["pixel brick"],
  "кирпич astera":  ["pixel brick"],
  "кирпич астера":  ["pixel brick"],

  // ── COB — общие типы ───────────────────────────────────────────────────────
  "cob":            ["storm", "electric storm", "ls 1200", "ls 1000", "ls 60", "molus", "amaran", "ulanzi vl"],
  "point source":   ["storm", "electric storm", "ls 1200", "ls 1000", "ls 60", "molus", "amaran"],
  "hard light":     ["storm", "electric storm", "ls 1200", "ls 1000"],
  "hmi":            ["storm", "electric storm", "ls 1200"],
  "par":            ["storm", "ls 1200", "ls 1000"],

  // ── LED Панели — конкретные модели ────────────────────────────────────────
  "nova ii":        ["nova ii"],
  "nova 2x1":       ["nova ii"],
  "тысячная нова":  ["nova ii"],
  "нова 2x1":       ["nova ii"],

  "nova p600":      ["nova p600"],
  "p600c":          ["nova p600"],
  "p600":           ["nova p600"],
  "шестисотая нова": ["nova p600"],

  "nova p300":      ["nova p300"],
  "p300c":          ["nova p300"],
  "p300":           ["nova p300"],
  "трёхсотая нова": ["nova p300"],

  "amaran f22":     ["амаран коврик"],
  "f22c":           ["амаран коврик"],
  "амаран коврик":  ["амаран коврик"],
  "амаран мат":     ["амаран коврик"],
  "мат 2x2":        ["амаран коврик"],

  "pavoslim 240c long": ["pavoslim 240 с long", "pavoslim 240c long"],
  "pavoslim long":  ["pavoslim 240 с long"],
  "длинный паво":   ["pavoslim 240 с long"],
  "лонг 240":       ["pavoslim 240 с long"],

  "pavoslim 240c":  ["pavoslim 240"],
  "pavoslim 240":   ["pavoslim 240"],
  "квадратный паво": ["pavoslim 240 с квадратный"],
  "240c квадрат":   ["pavoslim 240 с квадратный"],

  "pavoslim 60":    ["pavoslim 60"],
  "малый паво":     ["pavoslim 60"],
  "шестидесятка паво": ["pavoslim 60"],

  "litemat spectrum 4": ["litemat spectrum 4"],
  "litemat 4":      ["litemat spectrum 4"],
  "лайтмат четвёрка": ["litemat spectrum 4"],
  "мат четвёрка":   ["litemat spectrum 4"],
  "spectrum 4":     ["litemat spectrum 4"],

  "litemat spectrum 2l": ["litemat spectrum 2l"],
  "litemat 2l":     ["litemat spectrum 2l"],
  "лайтмат 2l":     ["litemat spectrum 2l"],
  "длинный лайтмат": ["litemat spectrum 2l"],

  "luxed-12":       ["luxed-12"],
  "luxed 12":       ["luxed-12"],
  "люксед 12":      ["luxed-12"],
  "led brute":      ["luxed-12", "luxed-9"],
  "брут":           ["luxed-12", "luxed-9"],

  "luxed-9":        ["luxed-9"],
  "luxed 9":        ["luxed-9"],
  "девятиглазый":   ["luxed-9"],
  "малый брут":     ["luxed-9"],

  "jumbo 12":       ["jumbo 12"],
  "джамбо":         ["jumbo 12"],
  "двенашка":       ["jumbo 12", "1200x"],
  "12к":            ["jumbo 12"],

  // ── LED Панели — общие типы ───────────────────────────────────────────────
  "led panel":      ["nova", "panel", "панель", "litemat", "pavoslim", "luxed", "jumbo"],
  "soft panel":     ["nova", "litemat", "pavoslim"],
  "rgbww panel":    ["nova", "pavoslim", "litemat"],
  "skypanel":       ["nova p600", "nova p300", "nova ii"],
  "softbox panel":  ["nova p300", "nova p600"],
  "litemat":        ["litemat", "spectrum"],
  "pavoslim":       ["pavoslim"],
  "nova":           ["nova"],

  // ── Надувные / Pipe ───────────────────────────────────────────────────────
  "infinimat 4x4":  ["infinimat 4x4"],
  "инфинимат 4x4":  ["infinimat 4x4"],
  "надувной 4x4":   ["infinimat 4x4", "pipe 44"],
  "мат 4x4":        ["infinimat 4x4", "pipe 44"],

  "infinimat 8x8":  ["infinimat 8x8"],
  "инфинимат 8x8":  ["infinimat 8x8"],
  "надувной 8x8":   ["infinimat 8x8", "pipe 84"],
  "мат 8x8":        ["infinimat 8x8"],

  "pipe 44":        ["pipe 44"],
  "матрас 4x4":     ["pipe 44"],
  "эйрмат 4x4":     ["pipe 44"],
  "надувной ковёр": ["pipe 44", "pipe 84"],

  "pipe 84":        ["pipe 84"],
  "матрас 8x4":     ["pipe 84"],
  "матрас 8 4":     ["pipe 84"],

  "ulanzi air light 60": ["ulanzi air-light 60"],
  "ulanzi air light 120": ["ulanzi air-light 120"],
  "air light":      ["ulanzi air"],
  "эйрлайт":        ["ulanzi air"],
  "надувной 60":    ["ulanzi air-light 60"],
  "надувной 120":   ["ulanzi air-light 120"],
  "малый надувной": ["ulanzi air-light  20"],

  "inflatable":     ["infinimat", "pipe 44", "pipe 84", "ulanzi air"],
  "mat light":      ["infinimat", "pipe 44", "pipe 84"],
  "air mat":        ["infinimat", "pipe 44", "pipe 84", "ulanzi air"],
  "overhead soft":  ["infinimat", "pipe 84", "nova", "litemat"],

  // ── Аккумуляторный / батарейные практики ──────────────────────────────────
  "titan tube":     ["titan tube"],
  "astera titan":   ["titan tube"],
  "трубки astera":  ["titan tube"],
  "титаны":         ["titan tube"],
  "астеры трубки":  ["titan tube"],

  "sidus one":      ["sidus one"],
  "сидус":          ["sidus"],
  "сидус трансивер": ["sidus"],
  "crmx transceiver": ["sidus"],

  "accent b7c":     ["b7c"],
  "b7c":            ["b7c"],
  "умная лампочка": ["b7c"],
  "rgb bulb":       ["b7c", "лампочк"],
  "practical bulb": ["b7c", "лампочк"],

  "mt pro":         ["mt pro"],
  "aputure mt":     ["mt pro"],
  "маленькая трубка": ["mt pro"],
  "мини трубка":    ["mt pro"],
  "pixel tube":     ["titan tube", "mt pro"],

  "mc pro":         ["mc pro"],
  "эмсик":          ["mc pro"],

  "aputure mc":     ["aputure mc"],
  "эмсишка":        ["aputure mc"],
  "карманный апутур": ["aputure mc"],

  "astera box":     ["astera box"],
  "asterabox":      ["astera box"],
  "бокс астеры":    ["astera box"],

  "v-mount battery": ["vmount"],
  "v-mount":        ["vmount"],
  "vmount":         ["vmount"],
  "вимаунт":        ["vmount"],
  "вилок":          ["vmount"],

  // ── Насадки / модификаторы — конкретные ──────────────────────────────────
  "light dome 150": ["light dome 150"],
  "лайтдом 150":    ["light dome 150"],
  "купол 150":      ["light dome 150"],
  "ld 150":         ["light dome 150"],

  "light dome ii":  ["light dome ii"],
  "лайтдом 90":     ["light dome ii"],
  "купол 90":       ["light dome ii"],
  "ld 90":          ["light dome ii"],

  "light dome mini": ["light dome mini"],
  "лайтдом мини":   ["light dome mini"],
  "купол мини":     ["light dome mini"],

  "aputure lantern": ["lantern"],
  "lantern":        ["lantern", "чайнабол"],
  "чайнабол":       ["lantern", "чайнабол"],
  "чайник":         ["lantern", "чайнабол"],
  "лантерн":        ["lantern", "чайнабол"],
  "china ball":     ["lantern", "чайнабол"],
  "china lantern":  ["lantern", "чайнабол"],
  "omnidirectional softbox": ["lantern", "чайнабол"],

  "spotlight mount": ["spotlight mount"],
  "spotlight max":  ["spotlight max"],
  "спотлайт":       ["spotlight"],
  "проекционник":   ["spotlight"],
  "лeko":           ["spotlight"],
  "profile attachment": ["spotlight"],
  "ellipsoidal":    ["spotlight"],
  "projection":     ["spotlight"],

  "cf7 fresnel":    ["cf7"],
  "cf7":            ["cf7"],
  "cf12 fresnel":   ["cf12"],
  "cf12":           ["cf12"],
  "cf16 fresnel":   ["cf16"],
  "cf16":           ["cf16"],
  "fresnel":        ["fresnel", "cf7", "cf12", "cf16", "фресне"],
  "линза":          ["fresnel", "cf7", "cf12", "cf16"],
  "фресне":         ["fresnel"],

  "hyper reflector": ["hyper reflector"],
  "рефлектор":      ["reflector", "рефлектор", "hyper"],

  "eggcrate":       ["соты", "grid"],
  "honeycomb":      ["соты", "grid"],
  "соты":           ["соты"],
  "грид":           ["соты", "grid"],
  "grid":           ["соты", "grid"],

  "barndoor":       ["barndoor", "шторки", "кашетир"],
  "barn door":      ["barndoor", "шторки", "кашетир"],
  "шторки":         ["шторки", "barndoor"],
  "барндоры":       ["шторки", "barndoor"],

  "softbox":        ["light dome", "softbox", "софтбокс"],
  "light dome":     ["light dome"],
  "octabox":        ["light dome", "softbox"],
  "parabolic":      ["light dome", "softbox"],

  // ── Стойки / грип ─────────────────────────────────────────────────────────
  "c-stand":        ["c-stand", "c stand", "avenger 40", "avenger 30", "avenger 20"],
  "c stand":        ["c-stand"],
  "century stand":  ["c-stand"],
  "си-стенд":       ["c-stand"],
  "сентури":        ["c-stand"],

  "combo stand":    ["combo", "super b", "avenger b", "avenger a"],
  "overhead stand": ["overhead 58", "monfrotto heavy"],
  "оверхед":        ["overhead 58", "monfrotto"],
  "роллер":         ["overhead 58", "monfrotto"],

  "lowboy":         ["lowboy", "кормилец"],
  "low boy":        ["lowboy", "кормилец"],
  "кормилец":       ["кормилец", "lowboy"],
  "лоубой":         ["lowboy", "кормилец"],

  "boom arm":       ["d600cb", "boom"],
  "boom":           ["d600cb", "boom", "журавль"],
  "журавль":        ["d600cb", "журавль"],
  "бум":            ["d600cb", "boom"],

  "autopole":       ["автополе"],
  "auto pole":      ["автополе"],
  "автополе":       ["автополе"],
  "распорка":       ["автополе"],
  "pressure pole":  ["автополе"],

  "floor stand":    ["лягушка"],
  "лягушка":        ["лягушка"],
  "frog stand":     ["лягушка"],

  "light stand":    ["avenger a100", "avenger b200", "super b250", "manfrotto 1004"],
  "stand":          ["avenger", "combo", "super b", "manfrotto"],

  "super clamp":    ["super clamp"],
  "spring clamp":   ["spring clamp"],
  "кламп":          ["super clamp", "clamp", "зажим"],
  "зажим":          ["super clamp", "зажим", "clamp"],
  "grip head":      ["grip head", "jumbo grip"],
  "грипхед":        ["grip head"],

  "magic arm":      ["magic arm", "magic flex"],
  "articulating arm": ["magic arm", "magic flex"],
  "мэджик арм":     ["magic arm"],
  "рука":           ["magic arm", "magic flex"],

  "sandbag":        ["мешок"],
  "shot bag":       ["мешок"],
  "сэндбэг":        ["мешок"],
  "мешок":          ["мешок"],

  "apple box":      ["apple"],
  "эппл":           ["apple"],
  "яблоко":         ["apple"],

  // ── Флаги / каттеры / текстиль ────────────────────────────────────────────
  "flag":           ["флаг", "flag"],
  "solid flag":     ["флаг", "flag"],
  "флаг":           ["флаг"],
  "солид":          ["флаг"],

  "cutter":         ["катер", "каттер", "cutter"],
  "каттер":         ["катер", "каттер"],

  "floppy":         ["флоппи", "floppy"],
  "флоппи":         ["флоппи"],
  "floppy tent":    ["флоппи", "уважуха"],
  "уважуха":        ["уважуха", "флоппи"],

  "scrim":          ["сетка"],
  "net":            ["сетка"],
  "сетка":          ["сетка"],

  "cucoloris":      ["куколорис"],
  "cookie":         ["куколорис"],
  "куколорис":      ["куколорис"],
  "куки":           ["куколорис"],

  "foamcore":       ["пена"],
  "polyboard":      ["пена"],
  "foam board":     ["пена"],
  "пена":           ["пена"],
  "пенка":          ["пена"],

  "mirror board":   ["зеркало"],
  "зеркало":        ["зеркало"],
  "hard reflector": ["зеркало"],

  "eyelighter":     ["подглазник"],
  "eyebrow":        ["подглазник"],
  "подглазник":     ["подглазник"],
  "under eye bounce": ["подглазник"],

  "negative fill":  ["флаг", "флоппи", "пена", "black"],
  "black solid":    ["флоппи", "флаг"],

  // ── Текстиль ──────────────────────────────────────────────────────────────
  "ultrabounce":    ["mattbounce", "ultrabounce"],
  "mattebounce":    ["mattbounce"],
  "bounce rag":     ["mattbounce", "ultrabounce"],
  "ультрабаунс":    ["mattbounce", "ultrabounce"],
  "баунс":          ["mattbounce", "ultrabounce"],
  "bounce":         ["mattbounce", "ultrabounce"],

  "silk":           ["silk", "силк", "текстиль"],
  "силк":           ["silk"],

  "diffusion frame": ["рама фростовая", "рама"],
  "butterfly frame": ["рама", "рама модульная"],
  "рама":           ["рама", "рама фростовая"],

  "silent diffusion": ["sd"],
  "soft diffusion": ["sd"],
  "sd rag":         ["sd"],
  "эс-ди":          ["sd"],
  "diffusion":      ["текстиль", "sd", "frost", "silk", "рама фростовая"],
  "frost":          ["рама фростовая", "текстиль sd"],

  "blackout":       ["black", "block"],
  "block rag":      ["black", "block"],
  "блэк":           ["black", "block"],
  "блок":           ["black", "block"],

  "silver rag":     ["silver"],
  "checkerboard":   ["silver"],
  "чекер":          ["silver"],
  "серебро":        ["silver"],

  "gel":            ["фильтра ассорти"],
  "color gel":      ["фильтра ассорти"],
  "гели":           ["фильтра ассорти"],
  "фильтры":        ["фильтра ассорти"],

  // ── Атмосфера / дымы ──────────────────────────────────────────────────────
  "antari hz":      ["hz350", "antari hz"],
  "hz-350":         ["hz350"],
  "hz350":          ["hz350"],
  "hazer":          ["hz350", "хейзер", "haze"],
  "хейзер":         ["хейзер", "hz350"],

  "antari z3000":   ["z3000"],
  "z3000":          ["z3000"],
  "большая дымка":  ["z3000"],
  "fog machine":    ["z3000", "дыммашина", "дым"],
  "дыммашина":      ["z3000", "antari"],
  "мобильная дымка": ["мобильная дым"],
  "ручная дымка":   ["мобильная дым"],

  "haze machine":   ["hz350", "хейзер 1800"],
  "haze":           ["hz350", "хейзер"],
  "1800w hazer":    ["хейзер 1800"],
  "большой хейзер": ["хейзер 1800"],

  "fan":            ["вентилятор"],
  "wind machine":   ["ветродуй"],
  "ветродуй":       ["ветродуй"],
  "дуйка":          ["ветродуй"],

  // ── Питание / электрика ───────────────────────────────────────────────────
  "power distro":   ["дестрибьютор", "дистрибьютер", "alpenbox"],
  "distro":         ["дестрибьютор", "дистрибьютер"],
  "distribution box": ["дестрибьютор", "дистрибьютер"],
  "breakout box":   ["дестрибьютор"],
  "дистро":         ["дестрибьютор", "дистрибьютер"],
  "дистриб":        ["дестрибьютор", "дистрибьютер"],

  "alpenbox":       ["alpenbox"],
  "альпенбокс":     ["alpenbox"],

  "generator":      ["генератор", "вепрь"],
  "геник":          ["генератор", "вепрь"],
  "три фазы":       ["генератор", "вепрь"],
  "77 ква":         ["вепрь"],

  "extension cord": ["удлинитель"],
  "stinger":        ["удлинитель"],
  "удлинитель":     ["удлинитель"],

  "power cable":    ["кабель"],
  "feeder cable":   ["кабель"],
  "хвост":          ["кабель"],
  "кабель":         ["кабель"],

  "dmx":            ["sidus", "dmx connect"],
  "crmx":           ["sidus", "astera box"],
  "wireless control": ["sidus", "astera box"],

  // ── Трубы / риг ───────────────────────────────────────────────────────────
  "speed rail":     ["трубы", "труба"],
  "спидрейл":       ["трубы", "труба"],
  "rigging pipe":   ["трубы", "труба"],

  "modular frame":  ["рама модульная"],
  "butterfly":      ["рама модульная"],
  "t-bone":         ["t-bon"],
  "тибон":          ["t-bon"],

  // ── Конкурентные / индустриальные → наш каталог ──────────────────────────
  // ARRI SkyPanel → Nova (по мощности)
  "skypanel s360":  ["nova ii"],
  "skypanel s120":  ["nova ii", "nova p600"],
  "skypanel s60":   ["nova p600", "nova p300"],
  "skypanel s45":   ["nova p300"],
  "skypanel s30":   ["nova p300"],

  // ARRI HMI / M-series → LS/Storm
  "arri m40":       ["52xt", "electric storm 52"],
  "arri m18":       ["1200x", "ls 1200"],
  "arri m8":        ["1000c"],
  "arri orbiter":   ["400x", "storm 400"],
  "m40":            ["52xt", "electric storm 52"],
  "m18":            ["1200x", "ls 1200"],
  "joker 800":      ["1000c"],
  "joker 400":      ["400x"],

  // ARRI Fresnel / L-series
  "arri fresnel":   ["cf12", "cf16", "cf7"],
  "arri l10":       ["nova p300"],
  "arri l7":        ["ls 60", "nova p300"],

  // Litepanels
  "gemini 2x1":     ["nova ii", "nova p600"],
  "gemini 1x1":     ["nova p300"],
  "litepanels gemini": ["nova ii", "nova p600", "nova p300"],
  "litepanels astra": ["nova p300", "pavoslim"],
  "astra 6x":       ["nova p600"],

  // Kinoflo
  "kinoflo celeb 450": ["nova p600"],
  "kinoflo celeb 250": ["nova p300"],
  "kinoflo celeb":  ["nova p600", "nova p300"],
  "kinoflo 4bank":  ["nova p300", "pavoslim"],
  "kinoflo":        ["nova p300", "nova p600", "pavoslim"],

  // Quasar Science
  "quasar science": ["titan tube", "mt pro"],
  "quasar rainbow": ["titan tube"],
  "q-led":          ["titan tube", "mt pro"],
  "x-lamp":         ["titan tube", "b7c"],

  // Nanlite (модели которых нет в каталоге)
  "forza 500":      ["1200x"],
  "forza 300":      ["1000c"],
  "forza 200":      ["400x"],
  "forza 150":      ["storm 400", "400x"],
  "forza 60":       ["ls 60"],
  "pavotube":       ["titan tube"],
  "nanlite forza":  ["1200x", "1000c", "400x"],

  // Profoto
  "profoto b10":    ["storm 80"],
  "profoto b1":     ["storm 400", "400x"],
  "profoto d2":     ["storm 400", "1000c"],
  "profoto":        ["storm 400", "1000c", "storm 80"],

  // Dedolight
  "dled 9":         ["ls 60"],
  "dled 4":         ["ls 60"],
  "dedolight":      ["ls 60", "molus g200"],

  // Godox
  "godox sl200":    ["molus g200"],
  "godox sl300":    ["molus g300"],
  "godox sl":       ["molus g200", "molus g300"],
  "godox m600":     ["1000c"],
  "godox":          ["molus g200", "molus g300", "amaran 200"],

  // Amaran (models not in catalog)
  "amaran 60x":     ["ls 60"],
  "amaran 300c":    ["storm 400", "molus g300"],
  "amaran 100x":    ["storm 80", "ls 60"],
  "amaran p60c":    ["nova p300"],

  // Astera (models not in catalog)
  "astera ax1":     ["titan tube"],
  "astera ax3":     ["titan tube"],
  "astera helios":  ["nova p300", "ls 60"],
  "astera hydrapanel": ["pavoslim"],
  "astera nyx":     ["nova p300", "ls 60"],

  // Ulanzi (другие модели)
  "ulanzi vl200":   ["ulanzi vl"],
  "ulanzi vl120":   ["storm 80", "molus g200"],

  // Inflatable / mat → infinimat / pipe
  "balloon light":  ["infinimat", "pipe"],
  "airstar":        ["infinimat", "pipe"],
  "moonball":       ["infinimat", "pipe"],
  "chimera lantern": ["lantern", "чайнабол"],
  "chimera softbox": ["light dome", "softbox"],
  "chimera":        ["light dome 150", "light dome ii"],

  // Westcott / Elinchrom modifiers
  "westcott rapid box": ["light dome"],
  "elinchrom softbox":  ["light dome"],
  "photek":         ["light dome 150"],

  // Generic industry terms AI might use
  "hmi fresnel":    ["cf12", "cf16", "1200x"],
  "par can":        ["storm 400", "ls 1200"],
  "open face":      ["storm", "electric storm", "ls 1200"],
  "chinese lantern":["lantern", "чайнабол"],
  "book light":     ["nova p600", "nova p300", "litemat"],
  "tungsten fresnel": ["cf12", "cf16"],
  "led fresnel":    ["cf7", "cf12", "cf16"],
  "led fixture":    ["storm", "nova", "ls 1200"],
  "soft box":       ["light dome", "softbox"],
  "para":           ["light dome 150", "light dome ii"],
  "octodome":       ["light dome 150"],
  "beauty dish":    ["light dome", "hyper reflector"],
  "strip light":    ["pavoslim", "litemat 2l"],
  "strip box":      ["pavoslim", "litemat 2l"],
  "egg crate":      ["соты"],
  "kino flo":       ["nova p300", "pavoslim"],
  "tube bank":      ["nova p300", "titan tube"],
};

async function main() {
  console.log(`[migrate-aliases-to-db] Запуск${DRY_RUN ? " (--dry-run, без записи в БД)" : ""}`);

  // Конвертация старых строковых значений source → enum (для существующих записей на продакшене)
  if (!DRY_RUN) {
    await prisma.$executeRawUnsafe(
      `UPDATE SlangAlias SET source = 'AUTO_LEARNED' WHERE source = 'approved_candidate'`
    );
    await prisma.$executeRawUnsafe(
      `UPDATE SlangAlias SET source = 'MANUAL_ADMIN' WHERE source = 'manual_admin'`
    );
    await prisma.$executeRawUnsafe(
      `UPDATE SlangAlias SET source = 'SEED' WHERE source = 'seed'`
    );
    console.log(`[migrate-aliases-to-db] Конвертация старых source-значений завершена`);
  }

  const allEquipment = await prisma.equipment.findMany({
    select: { id: true, name: true },
  });

  console.log(`[migrate-aliases-to-db] Загружено позиций оборудования: ${allEquipment.length}`);

  // Нормализованные имена для быстрого поиска
  const normalizedEquipment = allEquipment.map((e) => ({
    id: e.id,
    name: e.name,
    normName: norm(e.name),
  }));

  let totalMatched = 0;
  let totalCreated = 0;
  let totalDuplicates = 0;
  let totalUnmatched = 0;

  for (const [phrase, searchTerms] of Object.entries(TYPE_SYNONYMS)) {
    const phraseNormalized = norm(phrase);

    // Находим все совпадающие позиции по всем search terms
    const matchedEquipmentIds = new Set<string>();

    for (const term of searchTerms) {
      const normTerm = norm(term);
      for (const eq of normalizedEquipment) {
        if (eq.normName.includes(normTerm)) {
          matchedEquipmentIds.add(eq.id);
        }
      }
    }

    if (matchedEquipmentIds.size === 0) {
      console.warn(`[migrate-aliases-to-db] UNMATCHED: "${phrase}" (search terms: ${searchTerms.join(", ")})`);
      totalUnmatched++;
      continue;
    }

    totalMatched += matchedEquipmentIds.size;

    for (const equipmentId of matchedEquipmentIds) {
      const eq = allEquipment.find((e) => e.id === equipmentId)!;

      if (DRY_RUN) {
        console.log(`  [dry-run] UPSERT SlangAlias { phraseNormalized: "${phraseNormalized}", phraseOriginal: "${phrase}", equipmentId: "${equipmentId}" (${eq.name}), source: SEED }`);
        totalCreated++;
      } else {
        const existing = await prisma.slangAlias.findUnique({
          where: { phraseNormalized_equipmentId: { phraseNormalized, equipmentId } },
        });

        if (existing) {
          totalDuplicates++;
          continue;
        }

        await prisma.slangAlias.create({
          data: {
            phraseNormalized,
            phraseOriginal: phrase,
            equipmentId,
            source: "SEED",
            confidence: 1.0,
            usageCount: 1,
          },
        });
        totalCreated++;
      }
    }
  }

  console.log("\n[migrate-aliases-to-db] Итого:");
  console.log(`  Совпадений найдено:    ${totalMatched}`);
  if (!DRY_RUN) {
    console.log(`  Создано записей:       ${totalCreated}`);
    console.log(`  Пропущено дубликатов:  ${totalDuplicates}`);
  } else {
    console.log(`  Будет создано (dry):   ${totalCreated}`);
  }
  console.log(`  Без совпадений (warn): ${totalUnmatched}`);
}

main()
  .catch((err) => {
    console.error("[migrate-aliases-to-db] Ошибка:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
