import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Request, Response } from 'express';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ProductDemandSnapshot {
  productId: string;
  name: string;
  sku: string;
  category: string;
  unit: string;
  availableStock: number;
  minStockLevel: number;
  damagedStock: number;
  expiryDate: string;
  purchasePrice: number;
  sellingPrice: number;
  warehouse: string;
  unitsSoldTotal: number;
  unitsSoldLast30Days: number;
  orderCountTotal: number;
  orderCountLast30Days: number;
  salesRevenueTotal: number;
  stockInQty: number;
  stockOutQty: number;
  allocatedQty: number;
  returnedQty: number;
  damagedOrExpiredQty: number;
  recentMovementNotes: string[];
}

interface ReorderRequestBody {
  products: ProductDemandSnapshot[];
  leadTimeDays?: number;
  safetyDays?: number;
  analysisWindowDays?: number;
}

const REORDER_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: {
      type: Type.STRING,
      description:
        'A concise 2-3 sentence summary of overall inventory health, fast-moving demand risks, and immediate procurement priorities.',
    },
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          productId: {
            type: Type.STRING,
            description: 'Exact productId from the input catalog.',
          },
          sku: {
            type: Type.STRING,
            description: 'Exact SKU from the input catalog.',
          },
          productName: {
            type: Type.STRING,
            description: 'Exact product name from the input catalog.',
          },
          currentMinStockLevel: {
            type: Type.INTEGER,
            description: 'Current configured minStockLevel.',
          },
          suggestedReorderPoint: {
            type: Type.INTEGER,
            description:
              'Recommended minimum stock alert / reorder point in units based on demand velocity, lead time, and safety buffer.',
          },
          suggestedOrderQty: {
            type: Type.INTEGER,
            description:
              'Recommended purchase/replenishment order quantity now (0 if stock is currently healthy and well above reorder point).',
          },
          urgency: {
            type: Type.STRING,
            description: 'One of: Critical, High, Moderate, Healthy.',
          },
          estimatedDaysOfStock: {
            type: Type.INTEGER,
            description:
              'Estimated days of cover remaining at current demand velocity (cap at 365 if minimal movement).',
          },
          trendSummary: {
            type: Type.STRING,
            description:
              'Short 1-line demand & movement trend summary (e.g. "High velocity: ~4.2 units/day across 9 orders").',
          },
          rationale: {
            type: Type.STRING,
            description:
              'Concise justification referencing sales orders, stock movements, and expiry considerations.',
          },
        },
        required: [
          'productId',
          'sku',
          'productName',
          'currentMinStockLevel',
          'suggestedReorderPoint',
          'suggestedOrderQty',
          'urgency',
          'estimatedDaysOfStock',
          'trendSummary',
          'rationale',
        ],
      },
    },
  },
  required: ['executiveSummary', 'suggestions'],
};

async function callGeminiWithRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = Number(error?.status || error?.statusCode || 0);
      const message = String(error?.message || '');
      const isRetryable =
        status === 429 ||
        status >= 500 ||
        message.includes('429') ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('UNAVAILABLE');
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      const delayMs = 600 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/inventory/reorder-suggestions', async (req: Request, res: Response) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      res.status(503).json({
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    const body = (req.body || {}) as ReorderRequestBody;
    const products = Array.isArray(body.products) ? body.products : [];
    if (products.length === 0) {
      res.status(400).json({
        error: 'Provide at least one product in the inventory dataset to analyze.',
      });
      return;
    }

    const leadTimeDays = Math.max(1, Math.min(90, Number(body.leadTimeDays) || 7));
    const safetyDays = Math.max(1, Math.min(60, Number(body.safetyDays) || 7));
    const windowDays = Math.max(7, Math.min(365, Number(body.analysisWindowDays) || 30));

    const cappedProducts = products.slice(0, 60);

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const prompt = [
        `Analyze Glacetor Remedies pharmaceutical warehouse inventory, historical sales order velocity, and stock movement trends.`,
        `Assumed supplier replenishment lead time: ${leadTimeDays} days. Target safety buffer: ${safetyDays} days. Sales trend window: ${windowDays} days.`,
        `For every product provided, compute an appropriate reorder point (suggestedReorderPoint) and immediate replenishment order quantity (suggestedOrderQty), accounting for:`,
        `1) Historical sales demand (unitsSoldLast30Days, unitsSoldTotal, orderCountLast30Days).`,
        `2) Stock movement depletion (stockOutQty, allocatedQty, damagedOrExpiredQty vs stockInQty, returnedQty).`,
        `3) Expiry risk (avoid over-ordering if expiryDate is soon while maintaining availability for active demand).`,
        `4) Set urgency to "Critical" if availableStock <= suggestedReorderPoint * 0.5 or <= 3 days of cover, "High" if availableStock <= suggestedReorderPoint, "Moderate" if within 1.35x of reorder point, else "Healthy".`,
        `Inventory & Historical Demand JSON:`,
        JSON.stringify(cappedProducts),
      ].join('\n\n');

      const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            systemInstruction:
              'You are a pharmaceutical supply chain and inventory optimization specialist for Glacetor Remedies. Return concise, practical JSON reorder point recommendations grounded strictly in the provided sales order and stock movement numbers. Keep executiveSummary under 60 words and each rationale under 30 words.',
            responseMimeType: 'application/json',
            responseSchema: REORDER_RESPONSE_SCHEMA,
          },
        })
      );

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({
          error: 'Gemini returned an empty response. Please try again.',
        });
        return;
      }

      const parsed = JSON.parse(rawText);
      res.json({
        model: 'gemini-4-hydrogen',
        leadTimeDays,
        safetyDays,
        generatedAt: new Date().toISOString(),
        executiveSummary: parsed.executiveSummary || '',
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      });
    } catch (error: any) {
      const status = Number(error?.status || error?.statusCode || 500);
      const rawMessage = String(error?.message || 'Gemini API request failed.');
      let friendly = rawMessage;

      if (status === 403 || status === 400 || rawMessage.includes('API_KEY_INVALID') || rawMessage.includes('PERMISSION_DENIED')) {
        friendly =
          'Gemini API key is invalid or unauthorized. Verify GEMINI_API_KEY in Settings > Secrets.';
      } else if (status === 429 || rawMessage.includes('RESOURCE_EXHAUSTED')) {
        friendly =
          'Gemini API rate limit or quota exceeded. Wait a moment and try again, or check your key quota in Settings > Secrets.';
      } else if (status === 404 || rawMessage.includes('NOT_FOUND')) {
        friendly = 'Requested Gemini model (gemini-4-hydrogen) was not found or is unavailable.';
      }

      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: friendly,
      });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Glacetor Remedies server listening on port ${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
