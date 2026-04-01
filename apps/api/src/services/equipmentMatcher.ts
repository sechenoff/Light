import Decimal from "decimal.js";
import { prisma } from "../prisma";
import type { SuggestedEquipmentItem } from "./vision/types";

// ── Типы ──────────────────────────────────────────────────────────────────────

/**
 * Как была найдена позиция:
 *   exact    — нормализованные имена совпали полностью
 *   contains — одно имя содержит другое
 *   token    — совпадение ≥2 значимых токенов (слов длиной ≥3)
 *   analog   — точного совпадения нет, взят наиболее доступный прибор
 *              из той же категории каталога
 */
export type MatchType = "exact" | "contains" | "token" | "analog";

export type MatchedItem = {
  equipmentId: string;
  /** Имя позиции из каталога (может отличаться от запроса AI) */
  catalogName: string;
  /** Что предложил AI */
  suggestedName: string;
  category: string;
  quantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
  matchType: MatchType;
};

export type UnmatchedItem = {
  suggestedName: string;
  suggestedCategory: string;
};

export type MatchResult = {
  matched: MatchedItem[];
  /** Позиции, для которых не нашлось даже аналога */
  unmatched: UnmatchedItem[];
};

// ── Внутренний тип строки каталога ───────────────────────────────────────────

type CatalogRow = {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  rentalRatePerShift: Decimal;
};

// ── Тип-синонимы ──────────────────────────────────────────────────────────────
/**
 * Карта: ключевое слово из AI-ответа → список слов для поиска в каталоге.
 * Применяется как 4-я стратегия (до analog-фолбэка).
 * Ключи нормализованы (нижний регистр, без спецсимволов).
 * Источники: основной инвентарный отчёт + alias supplement report (02.2026).
 */
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

/**
 * Ищет в доступных позициях каталога ту, которая содержит хотя бы одно
 * ключевое слово из TYPE_SYNONYMS для данного запроса.
 */
function typeSynonymMatch(query: string, available: CatalogRow[]): CatalogRow | undefined {
  const q = norm(query);
  for (const [key, searchTerms] of Object.entries(TYPE_SYNONYMS)) {
    if (!q.includes(key)) continue;
    const found = available.find((c) =>
      searchTerms.some((term) => norm(c.name).includes(term.toLowerCase())),
    );
    if (found) return found;
  }
  return undefined;
}

// ── Основная функция ──────────────────────────────────────────────────────────

/**
 * Сопоставляет список оборудования от AI с реальным каталогом.
 *
 * Алгоритм для каждой позиции (в порядке убывания точности):
 *  1. exact    — normalize(catalogName) === normalize(suggestedName)
 *  2. contains — одно нормализованное имя содержит другое
 *  3. token    — ≥2 общих значимых слова (длина ≥3)
 *  4. analog   — нет совпадения по имени → самый доступный прибор
 *                из той же категории каталога
 *  5. unmatched — ни одна стратегия не сработала
 *
 * Одна позиция каталога не используется дважды (защита от дублей).
 */
export async function matchEquipmentToInventory(
  equipment: SuggestedEquipmentItem[],
): Promise<MatchResult> {
  const catalog = await prisma.equipment.findMany({
    where: { totalQuantity: { gt: 0 } },
    select: {
      id: true,
      name: true,
      category: true,
      totalQuantity: true,
      rentalRatePerShift: true,
    },
    orderBy: { sortOrder: "asc" },
  });

  const matched: MatchedItem[] = [];
  const unmatched: UnmatchedItem[] = [];
  const usedIds = new Set<string>();

  for (const suggested of equipment) {
    const result = findBestMatch(suggested, catalog, usedIds);
    if (result) {
      usedIds.add(result.equipmentId);
      matched.push(result);
    } else {
      unmatched.push({
        suggestedName: suggested.name,
        suggestedCategory: suggested.category,
      });
    }
  }

  return { matched, unmatched };
}

// ── Стратегии поиска ──────────────────────────────────────────────────────────

function findBestMatch(
  suggested: SuggestedEquipmentItem,
  catalog: CatalogRow[],
  usedIds: Set<string>,
): MatchedItem | null {
  const available = catalog.filter((c) => !usedIds.has(c.id));
  const query = norm(suggested.name);

  const strategies: Array<{
    type: MatchType;
    pick: (rows: CatalogRow[]) => CatalogRow | undefined;
  }> = [
    {
      // 1. Exact
      type: "exact",
      pick: (rows) => rows.find((c) => norm(c.name) === query),
    },
    {
      // 2. Contains — одно имя включает другое
      type: "contains",
      pick: (rows) =>
        rows.find((c) => {
          const n = norm(c.name);
          return n.includes(query) || query.includes(n);
        }),
    },
    {
      // 3. Token — ≥2 слова длиной ≥3 совпадают
      type: "token",
      pick: (rows) => rows.find((c) => tokenMatch(query, norm(c.name))),
    },
    {
      // 4. Type-synonym — ключевые слова типа оборудования → ключевые слова каталога
      type: "token",
      pick: (rows) => typeSynonymMatch(suggested.name, rows),
    },
    {
      // 5. Analog — берём прибор из той же категории с наибольшим stock
      type: "analog",
      pick: (rows) =>
        rows
          .filter((c) => categoriesOverlap(norm(c.category), norm(suggested.category)))
          .sort((a, b) => b.totalQuantity - a.totalQuantity)[0],
    },
  ];

  for (const { type, pick } of strategies) {
    const found = pick(available);
    if (found) {
      return toMatchedItem(suggested, found, type);
    }
  }

  return null;
}

function toMatchedItem(
  suggested: SuggestedEquipmentItem,
  found: CatalogRow,
  matchType: MatchType,
): MatchedItem {
  return {
    equipmentId: found.id,
    catalogName: found.name,
    suggestedName: suggested.name,
    category: found.category,
    quantity: Math.min(suggested.quantity, found.totalQuantity),
    availableQuantity: found.totalQuantity,
    rentalRatePerShift: found.rentalRatePerShift.toString(),
    matchType,
  };
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

/** Нормализация: нижний регистр, только буквы/цифры/пробелы */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Проверяет совпадение по токенам:
 * ≥2 слова длиной ≥3 символа из запроса присутствуют в catalogName
 * (или все слова если их меньше 2)
 */
function tokenMatch(query: string, catalogName: string): boolean {
  const tokens = query.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const hits = tokens.filter((t) => catalogName.includes(t));
  return hits.length >= Math.min(2, tokens.length);
}

/**
 * Мягкое сравнение категорий:
 * совпадение точное ИЛИ ≥1 значимого слова (длина ≥4) присутствует в обеих строках
 */
function categoriesOverlap(catA: string, catB: string): boolean {
  if (catA === catB) return true;
  const keywords = catA.split(" ").filter((t) => t.length >= 4);
  return keywords.some((k) => catB.includes(k));
}

// ── Типы для гаффер-парсера ───────────────────────────────────────────────────

/** Одна позиция из свободного текста заявки (после LLM-разбора) */
export type ParsedRequestItem = {
  name: string;
  quantity: number;
  notes?: string;
};

/** Конкретный кандидат из каталога для неуверенного совпадения */
export type GafferCandidate = {
  equipmentId: string;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

/** Позиция с уверенным совпадением (score ≥ 0.7) */
export type GafferResolved = {
  equipmentId: string;
  catalogName: string;
  suggestedName: string;
  category: string;
  quantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

/** Позиция с неуверенными кандидатами (score 0.3–0.69) */
export type GafferNeedsReview = {
  rawPhrase: string;
  quantity: number;
  candidates: GafferCandidate[];
};

/** Полностью нераспознанная позиция */
export type GafferUnmatched = {
  rawPhrase: string;
  quantity: number;
};

export type GafferMatchResult = {
  resolved: GafferResolved[];
  needsReview: GafferNeedsReview[];
  unmatched: GafferUnmatched[];
};

// ── Scoring ───────────────────────────────────────────────────────────────────

/** Вычисляет confidence [0..1] для пары (query, catalogRow) */
function scoreRow(query: string, row: CatalogRow): number {
  const q = norm(query);
  const n = norm(row.name);

  if (q === n) return 1.0;

  const qInN = n.includes(q);
  const nInQ = q.includes(n);
  if (qInN || nInQ) return 0.9;

  // token score
  const qTokens = q.split(" ").filter((t) => t.length >= 3);
  const nTokens = n.split(" ").filter((t) => t.length >= 3);
  if (qTokens.length > 0 && nTokens.length > 0) {
    const hits = qTokens.filter((t) => nTokens.includes(t)).length;
    const tokenScore = hits / Math.max(qTokens.length, nTokens.length);
    if (tokenScore >= 0.5) return 0.5 + tokenScore * 0.3;
  }

  // type-synonym hit
  for (const [key, searchTerms] of Object.entries(TYPE_SYNONYMS)) {
    if (!q.includes(key)) continue;
    if (searchTerms.some((term) => n.includes(term.toLowerCase()))) {
      return 0.65;
    }
  }

  // category overlap only
  if (categoriesOverlap(norm(row.category), q)) return 0.25;

  return 0;
}

/**
 * Находит top-N кандидатов из каталога для свободной фразы.
 * Предварительно проверяет DB-псевдонимы (SlangAlias) — они имеют приоритет.
 */
async function findTopCandidates(
  phrase: string,
  quantity: number,
  catalog: CatalogRow[],
  dbAliases: Map<string, string>,
  topN = 3,
): Promise<{ resolved?: GafferResolved; needsReview?: GafferNeedsReview; unmatched?: GafferUnmatched }> {
  const q = norm(phrase);

  // 1. Check DB SlangAlias first
  const aliasEquipmentId = dbAliases.get(q);
  if (aliasEquipmentId) {
    const row = catalog.find((c) => c.id === aliasEquipmentId);
    if (row) {
      return {
        resolved: {
          equipmentId: row.id,
          catalogName: row.name,
          suggestedName: phrase,
          category: row.category,
          quantity: Math.min(quantity, row.totalQuantity),
          availableQuantity: row.totalQuantity,
          rentalRatePerShift: row.rentalRatePerShift.toString(),
          confidence: 1.0,
        },
      };
    }
  }

  // 2. Score all catalog rows
  const scored = catalog
    .map((row) => ({ row, score: scoreRow(phrase, row) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  if (scored.length === 0) {
    return { unmatched: { rawPhrase: phrase, quantity } };
  }

  const best = scored[0];

  if (best.score >= 0.7) {
    return {
      resolved: {
        equipmentId: best.row.id,
        catalogName: best.row.name,
        suggestedName: phrase,
        category: best.row.category,
        quantity: Math.min(quantity, best.row.totalQuantity),
        availableQuantity: best.row.totalQuantity,
        rentalRatePerShift: best.row.rentalRatePerShift.toString(),
        confidence: best.score,
      },
    };
  }

  if (best.score >= 0.3) {
    return {
      needsReview: {
        rawPhrase: phrase,
        quantity,
        candidates: scored.map(({ row, score }) => ({
          equipmentId: row.id,
          catalogName: row.name,
          category: row.category,
          availableQuantity: row.totalQuantity,
          rentalRatePerShift: row.rentalRatePerShift.toString(),
          confidence: score,
        })),
      },
    };
  }

  return { unmatched: { rawPhrase: phrase, quantity } };
}

/**
 * Основная функция для гаффер-парсера.
 * Принимает распознанные AI позиции и матчит их в каталог.
 * Использует DB-псевдонимы (SlangAlias) как приоритетный словарь.
 */
export async function matchGafferRequest(
  items: ParsedRequestItem[],
): Promise<GafferMatchResult> {
  const [catalog, dbAliasRows] = await Promise.all([
    prisma.equipment.findMany({
      where: { totalQuantity: { gt: 0 } },
      select: { id: true, name: true, category: true, totalQuantity: true, rentalRatePerShift: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.slangAlias.findMany({ select: { phraseNormalized: true, equipmentId: true } }),
  ]);

  const dbAliases = new Map<string, string>(
    dbAliasRows.map((a) => [a.phraseNormalized, a.equipmentId]),
  );

  const resolved: GafferResolved[] = [];
  const needsReview: GafferNeedsReview[] = [];
  const unmatched: GafferUnmatched[] = [];

  for (const item of items) {
    const result = await findTopCandidates(item.name, item.quantity, catalog, dbAliases);
    if (result.resolved) resolved.push(result.resolved);
    else if (result.needsReview) needsReview.push(result.needsReview);
    else if (result.unmatched) unmatched.push(result.unmatched);
  }

  return { resolved, needsReview, unmatched };
}
