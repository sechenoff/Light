import { GoogleGenerativeAI } from "@google/generative-ai";
import type { VisionProvider } from "./vision/provider";
import type { VisionInput, LightingAnalysis } from "./vision/types";
import { parseLightingAnalysis } from "./vision/types";

/** Retry up to 2 times on 503/429 with exponential backoff */
async function retryOnOverload<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      if ((status === 503 || status === 429) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
        continue;
      }
      throw err;
    }
  }
}

const ANALYSIS_SYSTEM_PROMPT = `You are a professional gaffer and cinematographer with high-end commercial and music video experience.

Analyze the provided image (film still, music video frame, or commercial shot) and reconstruct the full lighting setup as accurately and technically as possible.

Your task is NOT to describe the image — your task is to reverse-engineer the lighting and grip setup.

IMPORTANT: This is a PROBABLE RECONSTRUCTION based on visual evidence — do not claim it is exact ground truth.

CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no comments, no extra text.
The "description" value MUST be a single plain string (use \\n for line breaks) — NOT a nested object or array.

Example of correct format:
{
  "description": "🎬 СЦЕНА: Brief scene overview here.\\n\\n💡 КЛЮЧЕВОЙ СВЕТ: Key light details here.\\n\\n🌓 ЗАПОЛНЯЮЩИЙ СВЕТ: Fill light details here.",
  "equipment": [
    { "name": "Aputure LS 1200x PRO (Blair)", "quantity": 1, "category": "Осветительные приборы" }
  ]
}

For the "description" string, include ALL of these sections separated by \\n\\n:

🎬 СЦЕНА: <1–2 sentences on scene mood and context>
💡 КЛЮЧЕВОЙ СВЕТ: <source, equipment model (Aputure/ARRI/Dedolight priority), light quality (hard/soft/diffused/bounced), direction, estimated distance in meters, color temperature in K, modifiers>
🌓 ЗАПОЛНЯЮЩИЙ СВЕТ: <fill light or explicitly "Заполнение отсутствует / естественный спад">
🔆 КОНТРОВОЙ / ОБВОДНОЙ СВЕТ: <rim/edge light presence, equipment, placement, height, intensity>
💫 ПРАКТИЧЕСКИЕ ИСТОЧНИКИ: <visible in-frame lights — real or enhanced with film lights>
🌫️ СРЕДА И АТМОСФЕРА: <bounce from walls/floor, ambient, haze, fog if present>
🎛️ ГРИП И МОДИФИКАТОРЫ: <flags, cutters, diffusion frames, bounce boards, negative fill, C-stands, overhead rigs, clamps>
⚡ ПИТАНИЕ И УПРАВЛЕНИЕ: <mains/generator/battery, cable routing, DMX/Sidus Link/CRMX if applicable>
📐 СХЕМА РАССТАНОВКИ: <clear spatial description — left/right/front/back, height: low/eye/overhead, distances in meters>
✂️ КАК ПОВТОРИТЬ МИНИМАЛЬНО: <practical suggestion to recreate with minimal gear>

Equipment list rules:
- PRIORITY: use the exact names from the AVAILABLE RENTAL INVENTORY section below whenever possible
- If you identify a fixture that is NOT in our inventory, substitute it with the closest functional equivalent using the SUBSTITUTION TABLE below
- Include ALL grip and modifier items, not just lights
- Categories: "Осветительные приборы", "Генераторы", "Рассеиватели и отражатели", "Штативы и стойки", "Кабели и коммутация", "Прочее"
- Quantity: realistic integer 1–10
- Total 5–15 line items covering lights + grip + modifiers + cabling
- Be precise. Do not be vague. Think like a working gaffer.

SUBSTITUTION TABLE — when you identify these fixtures, use our catalog equivalent:
Large-format RGBWW soft panels:
  ARRI SkyPanel S360 / S120          → Aputure NOVA II 2x1
  ARRI SkyPanel S60                  → Aputure NOVA P600C RGBWW
  ARRI SkyPanel S30 / S45            → Aputure NOVA P300C RGBWW
  Litepanels Gemini 2x1              → Aputure NOVA II 2x1
  Kinoflo Celeb 450 / 400            → Aputure NOVA P600C RGBWW
  Kinoflo Celeb 250 / 200            → Aputure NOVA P300C RGBWW
  Nanlite Pavoslim 240 (square)      → Nanlite PavoSlim 240 С Квадратный RGBWW
  Nanlite Pavoslim 240 (long/strip)  → Nanlite PavoSlim 240 С Long RGBWW
  LiteMat Spectrum 4                 → Litemat Spectrum 4 RGBWW
  LiteMat Spectrum 2L                → Litemat Spectrum 2L RGBWW
  Astera HydraPanel / NYX Panel      → Nanlite PavoSlim 240 С Квадратный RGBWW
  Inflatable overhead (4x4 class)    → Aputure INFINIMAT 4x4
  Inflatable overhead (8x8 class)    → Aputure INFINIMAT 8х8

High-output COB / point-source:
  ARRI M40 / M18 HMI (large)        → Aputure Electric storm 52XT (Blair)
  ARRI M18 / 1800W HMI              → Aputure LS 1200x PRO (Blair)
  ARRI M8 / Joker 800               → Aputure LS 1000C
  ARRI Orbiter / 600W LED            → Aputure STORM 400x
  Profoto D2 / B1X / B10X           → Aputure STORM 400x or Aputure LS 1000C
  Dedolight DLED 4 / DLED 9         → Aputure LS 60х 3200-6500k
  Nanlite Forza 500 / 300           → Aputure LS 1200x PRO (Blair) or Aputure LS 1000C
  Nanlite Forza 200 / 150           → Aputure STORM 400x
  Godox SL200 / SL300               → Zhiyun molus g200 or Zhiyun molus g300

Tubes / pixel linear:
  Astera AX1 / AX3 Titan            → Astera Titan Tube Kit (8 шт)
  Quasar Science Q-LED / Rainbow 2   → Astera Titan Tube Kit (8 шт)
  Nanlite PavoTube                   → Astera Titan Tube Kit (8 шт)
  Aputure MT Pro / mini tube         → Aputure MT Pro RGB

Battery practicals / accent:
  Astera NYX bulb / Titan bulb       → RGB лампочка Aputure B7C в кейсе
  Astera PixelBrick                  → Astera Pixel Brick KIT RGB
  Aputure MC / mini panel            → Светодиодная панель Aputure MC в кейсе

Fresnel / projection attachments:
  ARRI Fresnel lens (for 1200W)      → Линза френеля Aputure СF12 Fresnel для 1200x
  ARRI Fresnel lens (for large head) → Линза френеля Aputure СF16 Fresnel Motorised для 52xt
  Fresnel attachment (compact)       → Линза френеля Aputure CF7 (для 400х)
  Projection / profile attachment    → Насадка Spotlight Mount 19 градусов Bowens

Softboxes / modifiers:
  Any 150cm parabolic dome           → Софтбокс Aputure Light Dome 150 Bowens
  Any 90cm dome / octobox            → Софтбокс Aputure Light Dome II 90 Bowens
  Any lantern / china ball           → Чайнабол Aputure Lattern 90cm Bowens
  Chimera / large softbox            → Софтбокс Aputure Light Dome 150 Bowens

Atmosphere:
  Any professional hazer             → Хейзер Antari HZ350
  Any fog machine                    → Дыммашина ANTARI Z3000 II

Power / control:
  Any DMX / CRMX wireless transmitter → Sidus One
  Any power distribution box          → Дестрибьютор 32/380 - 3х32/220`;

const DIAGRAM_IMAGE_PROMPT = (description: string) =>
  `Create a top-down bird's-eye view lighting diagram for a film/photo studio setup.

Lighting setup to visualize:
"${description}"

STYLE — match this exact aesthetic:
- Overhead top-down perspective looking straight down at the studio floor
- Vintage craft paper / parchment background texture, slightly aged look
- The studio room is a rectangle with visible walls/boundaries drawn as dark lines, with door openings at top and bottom edges
- All light fixtures are realistic black studio lights seen from above (not abstract shapes), with visible power cables/wires drawn as loose curvy black lines on the floor
- Each light fixture emits a wide colored TRANSLUCENT CONE/BEAM of light directed toward the center subject — the beams should overlap and blend where they cross
- Color coding for light beams: warm lights (3200K) = yellow/amber glow, cool lights (5600K) = cyan/light blue glow, LED panels = purple/magenta glow, strobes = blue glow, reflectors = soft orange glow
- Center of the room: a simple white circular icon of a MODEL/SUBJECT (minimalist human figure symbol), labeled "MODEL"
- Bottom center: a PHOTOGRAPHER/CAMERA icon (simple camera silhouette), labeled "PHOTOGRAPHER"
- Each light fixture has a clear bold BLACK TEXT LABEL next to it: the light role + color temperature, e.g. "KEY LIGHT (WARM 3200K)", "FILL LIGHT (COOL 5600K)"
- Include a LEGEND box in the upper-right corner showing color swatches: WARM, REFLECTOR, STROBE, LED PANEL with matching colored squares
- The overall look should be clean, professional, and visually rich — like a well-designed lighting plan from a cinematography textbook
- No watermarks, no extra text beyond labels and legend
- Landscape orientation, high detail`;


/**
 * Робастный парсинг JSON — пробует несколько стратегий:
 * 1. Прямой JSON.parse
 * 2. Извлечение из markdown-блока ```json ... ```
 * 3. Ремонт: удаление trailing commas, BOM, управляющих символов
 * Возвращает parsed object или undefined при неудаче.
 */
function tryParseJson(raw: string): unknown | undefined {
  // 1. Прямой парсинг
  try {
    return JSON.parse(raw);
  } catch {}

  // 2. Markdown-блок
  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch?.[1]) {
    try {
      return JSON.parse(mdMatch[1].trim());
    } catch {}
  }

  // 3. Ремонт строки
  let repaired = raw
    .replace(/^\uFEFF/, "")                      // BOM
    .replace(/^[^{[]*/, "")                       // мусор до JSON
    .replace(/[^}\]]*$/, "")                      // мусор после JSON
    .replace(/,\s*([}\]])/g, "$1")                // trailing commas
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // control chars (кроме \t \n \r)

  try {
    return JSON.parse(repaired);
  } catch {}

  return undefined;
}

/**
 * Google Gemini Flash implementation of VisionProvider.
 * Инициализируется лениво — не бросает ошибку при старте если ключ не задан,
 * только при первом вызове.
 */
export class GeminiVisionProvider implements VisionProvider {
  readonly name = "gemini";

  private get client(): GoogleGenerativeAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    return new GoogleGenerativeAI(apiKey);
  }

  async analyzePhoto(input: VisionInput): Promise<LightingAnalysis> {
    const model = this.client.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { maxOutputTokens: 4096, responseMimeType: "application/json" },
    });

    const catalogSection = input.catalogHint?.length
      ? "\n\nAVAILABLE RENTAL INVENTORY — use these exact names in the equipment list when possible:\n" +
        input.catalogHint
          .map((g) => `[${g.category}]: ${g.names.join(", ")}`)
          .join("\n")
      : "";

    const contentParts = [
      { text: ANALYSIS_SYSTEM_PROMPT + catalogSection },
      {
        inlineData: {
          mimeType: input.mimeType,
          data: input.imageBuffer.toString("base64"),
        },
      },
    ];

    const result = await retryOnOverload(() => model.generateContent(contentParts));

    const raw = result.response.text().trim();
    console.log(`[gemini] analyzePhoto raw length=${raw.length}, first 200: ${raw.slice(0, 200)}`);

    // Робастный парсинг JSON: прямой → markdown-блок → ремонт строки
    let parsed: unknown;
    parsed = tryParseJson(raw);

    if (parsed === undefined) {
      throw new Error(`Gemini вернул невалидный JSON анализа: ${raw.slice(0, 400)}`);
    }

    // Если description пришёл как объект (Gemini иногда создаёт вложенный объект из emoji-заголовков)
    // — склеиваем значения в плоскую строку
    const obj = parsed as Record<string, unknown>;
    if (obj.description !== null && typeof obj.description === "object") {
      const descObj = obj.description as Record<string, string>;
      obj.description = Object.entries(descObj)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n\n");
    }

    // Если equipment — объект вместо массива, извлекаем значения
    if (obj.equipment && !Array.isArray(obj.equipment) && typeof obj.equipment === "object") {
      obj.equipment = Object.values(obj.equipment);
    }

    try {
      return parseLightingAnalysis(obj);
    } catch (zodErr: any) {
      console.error(`[gemini] Zod validation failed:`, zodErr?.issues ?? zodErr?.message ?? zodErr);
      console.error(`[gemini] Parsed object keys:`, Object.keys(obj));
      if (Array.isArray(obj.equipment)) {
        console.error(`[gemini] equipment[0]:`, JSON.stringify(obj.equipment[0])?.slice(0, 200));
        console.error(`[gemini] equipment count:`, obj.equipment.length);
      }
      console.error(`[gemini] description type:`, typeof obj.description, `len:`, String(obj.description).length);
      throw new Error(`Gemini JSON не прошёл валидацию: ${zodErr?.issues?.[0]?.message ?? zodErr?.message ?? "unknown"}`);
    }
  }

  async generateDiagram(description: string): Promise<Buffer | null> {
    try {
      const model = this.client.getGenerativeModel({
        model: "gemini-2.5-flash-image",
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
        } as any,
      });

      const result = await retryOnOverload(() => model.generateContent(DIAGRAM_IMAGE_PROMPT(description)));
      const response = result.response;
      const candidates = response.candidates;

      if (!candidates?.length) return null;

      // Find image part in response
      for (const part of candidates[0].content.parts) {
        if ((part as any).inlineData?.mimeType?.startsWith("image/")) {
          const imageData = (part as any).inlineData.data;
          return Buffer.from(imageData, "base64");
        }
      }

      return null;
    } catch (err) {
      console.error("Diagram generation error:", err);
      return null;
    }
  }
}
