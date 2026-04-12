// api/ai.js — Vercel Serverless Function: Gemini AI for Campaign Generation
import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `Você é um Estrategista e Head de Tráfego Pago Sênior (Meta Ads) focado em Alta Performance e Copywriting no Brasil.

O usuário vai descrever a campanha que precisa criar ou o contexto do negócio dele. Você vai analisar isso e retornar SOMENTE um JSON válido (sem marcação "\`\`\`json", apenas o objeto bruto) com a estrutura correta.

REGRAS OBRIGATÓRIAS (CRÍTICAS DA OPERAÇÃO):
1. 🚫 PROIBIDO O USO DE QUALQUER EMOJI. O tom da Copy (em headlines e textos) deve ser executivo, analítico, adulto e voltado para vendas e conversões, adequado ao nível de negócios/C-Level. Use gatilhos mentais sérios e copywriting avançado. Sem exageros, sem "olá amiguinhos". Focado em lucro e conversão.
2. 🧠 RACIOCÍNIO AUTÔNOMO DE PÚBLICO: Se o usuário não disser nada sobre público (idades, locais, interesses), haja como um especialista de verdade e INFERIR as informações analisando o nicho ou serviço. 
   - Estipule um 'age_min' e 'age_max' lógicos (ex: Imóveis de Luxo sugerem 35-65; Faculdades sugerem 18-35).
   - Defina um polo geográfico forte em 'cities' (e.g., capitais principais como "São Paulo", "Rio de Janeiro", "Belo Horizonte" etc.) se fizer mais sentido do que o país vasto vazio.
   - Preeencha 'interests_keywords' pensando no comportamento do consumidor daquela oferta específica.
3. headline: máximo 40 caracteres, focado na maior dor ou maior promessa (estritamente zero emojis).
4. primary_text: máximo 125 caracteres, estrutura AIDA refinada e enxuta (estritamente zero emojis).
5. description: máximo 30 caracteres, call-to-action de apoio.
6. daily_budget_brl: preencha um número coerente em R$ (ex: 50, 100, 200).
7. objective: escolha o melhor (OUTCOME_LEADS, OUTCOME_SALES etc).

MAPEAMENTO objective → optimization_goal:
- OUTCOME_TRAFFIC → LINK_CLICKS ou LANDING_PAGE_VIEWS
- OUTCOME_LEADS → LEAD_GENERATION
- OUTCOME_ENGAGEMENT → POST_ENGAGEMENT ou MESSAGES
- OUTCOME_SALES → OFFSITE_CONVERSIONS
- OUTCOME_AWARENESS → REACH

RETORNE EXATAMENTE este JSON:
{
  "campaign": {
    "name": "string",
    "objective": "OUTCOME_TRAFFIC|OUTCOME_LEADS|OUTCOME_ENGAGEMENT|OUTCOME_SALES|OUTCOME_AWARENESS",
    "daily_budget_brl": number
  },
  "adset": {
    "name": "string",
    "age_min": number,
    "age_max": number,
    "genders": [],
    "cities": ["string"],
    "interests_keywords": ["string"],
    "optimization_goal": "LINK_CLICKS|LEAD_GENERATION|MESSAGES|REACH|OFFSITE_CONVERSIONS"
  },
  "creative": {
    "headline": "string",
    "primary_text": "string",
    "description": "string",
    "cta": "SEND_MESSAGE|LEARN_MORE|SHOP_NOW|GET_QUOTE|SIGN_UP",
    "image_prompt": "string (descrição em português de como deve ser a imagem ideal para esse anúncio)"
  },
  "explanation": "string (explicação breve das escolhas feitas, máx 100 palavras)"
}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Descreva melhor o que você quer criar' });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7,
      }
    });

    const result = await model.generateContent([SYSTEM_PROMPT, `Pedido do usuário: ${prompt}`]);
    const text = result.response.text();

    let campaign_structure;
    try {
      campaign_structure = JSON.parse(text);
    } catch(e) {
      // Try to extract JSON from text if there's extra content
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        campaign_structure = JSON.parse(match[0]);
      } else {
        throw new Error('IA não retornou JSON válido');
      }
    }

    return res.json({ success: true, campaign_structure });

  } catch (err) {
    console.error('[AI] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
