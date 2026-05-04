import { GoogleGenAI, Type } from "@google/genai";

export async function testConnection(apiKey: string, modelName: string, apiBaseUrl?: string): Promise<boolean> {
  try {
    const isGemini = !apiBaseUrl && modelName.toLowerCase().includes('gemini');
    
    if (isGemini) {
      const ai = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY || "" });
      const result = await ai.models.generateContent({
        model: modelName || "gemini-3-flash-preview",
        contents: "Hi"
      });
      return !!result.text;
    } else {
      const baseUrl = apiBaseUrl || "https://api.openai.com/v1";
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: "Hi" }],
          max_tokens: 5
        })
      });
      return res.ok;
    }
  } catch (error) {
    console.error("Connection test failed:", error);
    return false;
  }
}

function parseJSONExtracted(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    // Attempt to extract JSON from markdown if present
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        // Find first { and last }
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          return JSON.parse(text.substring(start, end + 1));
        }
      }
    }
    throw new Error("Could not parse JSON from AI response.");
  }
}

export async function generateCopyForSingleImage(
  base64Image: { mimeType: string, data: string }, 
  config: { apiKey?: string; model?: string; apiBaseUrl?: string } = {},
  retries = 3, 
  initialDelayMs = 2000
): Promise<{
  direction: string;
  title: string;
  content: string;
  ending: string;
  callToAction: string;
  tags: string;
}> {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY || "";
  const modelName = config.model || "gemini-3-flash-preview";
  const apiBaseUrl = config.apiBaseUrl;
  const isGemini = !apiBaseUrl && modelName.toLowerCase().includes('gemini');

  const imagePart = {
    inlineData: {
      mimeType: base64Image.mimeType,
      data: base64Image.data.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, ""),
    }
  };

  const systemInstruction = `
# 「为家乡点赞」公众号图文内容生产技能 v3.2
## ——极简·去雷同·真情实感升级版

你是一个专门为覆盖全国的微信公众号矩阵撰写图文内容的资深文案专家。根据提供的图片，自动撰写公众号图文内容，并必须遵守以下核心指令。

【核心指令】
1. 极简字数：【正文、收尾、互动触发】三部分的总字数必须严格控制在 50 字以内。不要加入过多长篇大论的描述，只要精准干练的短打短句。
2. 句式多变：严禁使用一套固定模板或雷同句式。对于不同图片，必须使用截然不同的行文逻辑和句式切入（例如：时而借物抒情，时而悬念疑问，时而对话感，时而写实白描），做到千图千面。
3. 去AI味写作：禁止使用诸如“承载了无数人的梦想”、“岁月沉淀”、“流连忘返”、“不得不说”等套路词。写具体的人和瞬间，而非抽象感受。
4. 双向情感：情感落点要让在家的人想转发炫耀，让在外的人读了想家。

【输出要求】
格式严格如下：
【方向】[创意方向（如：自豪感/震撼感/共鸣钩子/旅游种草）]
▌标题：[标题]
▌正文：[正文]
▌收尾：[收尾]
▌互动触发：[互动触发]
▌标签：[标签]

【栏目要求】
1. 标题（极其重要！）：【字数红线，必须绝对遵守】标题总字数（含标点符号）必须在18到20个字之间！绝对不能少于18字，更绝对不能超过20字！少一个字或多一个字都是严重错误！必须使用爆款结构（数据挑战、反常识、数字冲击、悬念拷问等），要能抓住眼球。
2. 正文+收尾+互动触发：总字数严格 < 50字。
   - 提取图片核心要素（具体地点/事物）+ 真实具体的片段/数据钩子。不要长篇铺陈。
   - 收尾一句话击中人心。
   - 互动触发简短精确。
3. 标签规则（重点）：总数在10个左右，带有#号并以空格分隔。
   - （关键规则）：如果图片内容涉及省级信息，前2个标签必须是 #省名 和 #市名 两个；如果只是市级内容，则第1个标签只需要 #市名。
   - 然后，添加2-4个与当前图片内容紧密匹配的具体关键词标签。
   - 最后，剩余的标签必须从以下标准标签库中挑选补充：#家乡山水的记忆 #家乡的山景 #家乡山水美景 #家乡情怀分享 #家乡的记忆 #家乡的变化 #家乡烟火气 #家乡的骄傲 #家乡的味道 #家乡美食 #XX旅游 #XX旅游攻略（XX需替换为实际地方名）。

【绝对禁忌的AI味用语】
- "承载了无数人的梦想与回忆"
- "让人感受到岁月的沉淀与厚重"
- "散发着独特的魅力与韵味"
- "令人心旷神怡、流连忘返"
- "不得不说", "话不多说上图", "值得一提的是"
- "相信每一个XX人都", "这种感觉只有亲身经历"
`;

  const inputPrompt = `请仔细观察我上传的这张图片，生成独立的一组最适合它的公众号推文文案。请确保满足字数少于50字、句式独一无二的要求。本请求需要稳定的 JSON 结构输出。`;

  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (isGemini) {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: modelName,
          contents: { parts: [imagePart, { text: inputPrompt }] },
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                direction: { type: Type.STRING, description: "如：【方向】自豪感 × 共鸣式" },
                title: { type: Type.STRING, description: "标题，严格18-20字（含标点），绝不能超过20字" },
                content: { type: Type.STRING, description: "正文内容" },
                ending: { type: Type.STRING, description: "收尾句话" },
                callToAction: { type: Type.STRING, description: "互动触发（引导评论点赞转发）" },
                tags: { type: Type.STRING, description: "严格包含10个左右标签，#分隔" }
              },
              required: ["direction", "title", "content", "ending", "callToAction", "tags"]
            }
          }
        });

        const responseText = response.text;
        if (!responseText) throw new Error("Empty response from AI");
        
        return parseJSONExtracted(responseText) as {
          direction: string;
          title: string;
          content: string;
          ending: string;
          callToAction: string;
          tags: string;
        };
      } else {
        // OpenAI Compatible path
        const baseUrl = apiBaseUrl || "https://api.openai.com/v1";
        const promptWithInstruction = `${systemInstruction}\n\nIMPORTANT: You must return ONLY raw valid JSON text (not markdown wrapped). The JSON must be an object with string values for exact keys: "direction", "title", "content", "ending", "callToAction", "tags".\n\nCRITICAL: The 'title' field MUST be exactly 18 to 20 characters long. IT IS FORBIDDEN TO EXCEED 20 CHARACTERS.`;
        
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              {
                role: "system",
                content: promptWithInstruction
              },
              {
                role: "user",
                content: [
                  { type: "text", text: inputPrompt },
                  { type: "image_url", image_url: { url: `data:${base64Image.mimeType};base64,${base64Image.data.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, "")}` } }
                ]
              }
            ]
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`API Error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        const contentStr = data.choices?.[0]?.message?.content;
        if (!contentStr) throw new Error("Empty response from OpenAI-compatible API");

        return parseJSONExtracted(contentStr) as {
          direction: string;
          title: string;
          content: string;
          ending: string;
          callToAction: string;
          tags: string;
        };
      }
    } catch (error: any) {
      const isRateLimit = error?.status === "RESOURCE_EXHAUSTED" || error?.code === 429 || error?.message?.includes('429');
      if (isRateLimit && attempt < retries) {
        console.warn(`Rate limit hit. Retrying in ${delay}ms (Attempt ${attempt + 1} of ${retries})...`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2; // Exponential backoff
      } else {
        console.error("Gemini Generation Error:", error);
        throw error;
      }
    }
  }
  throw new Error("Failed to generate content after retries.");
}

