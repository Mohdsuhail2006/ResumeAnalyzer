import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';
import { createServer as createViteServer } from 'vite';

import { parseResumeText } from './server/resumeParser.ts';
import { parseJobDescription } from './server/jobParser.ts';
import { calculateMatch } from './server/matchingAlgorithm.ts';
import { generateAiInsights, generateInterviewQuestions, generateSampleAnswer } from './server/geminiService.ts';
import { DEFAULT_MATCH_CONFIG } from './server/config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // JSON and URL-encoded body parsers
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Configure Multer for PDF upload in memory
  const storage = multer.memoryStorage();
  const upload = multer({
    storage,
    limits: {
      fileSize: 10 * 1024 * 1024 // 10MB maximum
    },
    fileFilter: (_req, file, cb) => {
      const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
      if (isPdf) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file format. Please upload a valid PDF document.'));
      }
    }
  });

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY')
    });
  });

  // Endpoint 1: Upload and parse PDF resume
  app.post('/api/resume/upload', upload.single('resume'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No PDF file was uploaded. Please select a resume PDF.' });
        return;
      }

      const fileBuffer = req.file.buffer;
      if (!fileBuffer || fileBuffer.length === 0) {
        res.status(400).json({ error: 'The uploaded PDF file is empty (0 bytes).' });
        return;
      }

      // Extract text using pdf-parse
      let extractedText = '';
      let pageCount = 1;
      try {
        const parser = new PDFParse({ data: new Uint8Array(fileBuffer) });
        const textResult = await parser.getText();
        extractedText = (textResult?.text || '').trim();
        pageCount = textResult?.pages?.length || 1;
        await parser.destroy();
      } catch (pdfErr: any) {
        console.error('PDF text extraction error:', pdfErr);
        res.status(422).json({
          error: 'Unable to extract text from this PDF. The document might be image-only (scanned), encrypted, or corrupted. Please provide a standard text-based PDF.'
        });
        return;
      }

      if (!extractedText || extractedText.length < 20) {
        res.status(422).json({
          error: 'Extracted text is too short or empty. Ensure the resume PDF contains selectable digital text, not scanned images.'
        });
        return;
      }

      // Parse structured information
      const parsedResume = parseResumeText(extractedText, req.file.originalname);

      res.json({
        success: true,
        resume: parsedResume,
        meta: {
          pages: pageCount,
          characters: extractedText.length,
          fileName: req.file.originalname
        }
      });
    } catch (err: any) {
      console.error('Server resume upload error:', err);
      res.status(500).json({
        error: err.message || 'Unable to process the resume upload right now. Please try again.'
      });
    }
  });

  // Endpoint 2: Parse plain text resume
  app.post('/api/resume/parse-text', (req, res) => {
    try {
      const { text, fileName } = req.body;
      if (!text || typeof text !== 'string' || text.trim().length < 20) {
        res.status(400).json({ error: 'Please provide at least 20 characters of resume text to analyze.' });
        return;
      }

      const parsedResume = parseResumeText(text, fileName || 'Pasted Resume');
      res.json({
        success: true,
        resume: parsedResume
      });
    } catch (err: any) {
      console.error('Server parse-text error:', err);
      res.status(500).json({ error: 'Error parsing resume text. Please try again.' });
    }
  });

  // Endpoint 3: Parse Job Description
  app.post('/api/job/parse', (req, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string' || text.trim().length < 15) {
        res.status(400).json({ error: 'Please provide a valid job description with at least 15 characters.' });
        return;
      }

      const parsedJob = parseJobDescription(text);
      res.json({
        success: true,
        job: parsedJob
      });
    } catch (err: any) {
      console.error('Server job parse error:', err);
      res.status(500).json({ error: 'Error analyzing job description. Please try again.' });
    }
  });

  // Endpoint 4: Deterministic Match Calculation (Programmatic NLP)
  app.post('/api/match', (req, res) => {
    try {
      const { resume, jd, config } = req.body;
      if (!resume || !jd) {
        res.status(400).json({ error: 'Both parsed resume and job description are required for matching.' });
        return;
      }

      const matchResult = calculateMatch(resume, jd, config || DEFAULT_MATCH_CONFIG);
      res.json({
        success: true,
        matchResult
      });
    } catch (err: any) {
      console.error('Server match error:', err);
      res.status(500).json({ error: 'Error calculating match score. Please verify inputs.' });
    }
  });

  // Endpoint 5: AI Insights & Suggestions (Gemini)
  app.post('/api/ai/insights', async (req, res) => {
    try {
      const { resume, jd, matchResult } = req.body;
      if (!resume || !jd || !matchResult) {
        res.status(400).json({ error: 'Resume, job description, and match results are required for AI insights.' });
        return;
      }

      const insights = await generateAiInsights(resume, jd, matchResult);
      res.json({
        success: true,
        insights
      });
    } catch (err: any) {
      console.error('Server AI insights error:', err);
      res.status(500).json({
        error: 'AI suggestions are temporarily unavailable. Deterministic analysis remains unaffected.'
      });
    }
  });

  // Endpoint 6: AI Interview Questions
  app.post('/api/ai/interview-questions', async (req, res) => {
    try {
      const { resume, jd } = req.body;
      if (!resume || !jd) {
        res.status(400).json({ error: 'Resume and job description are required for question generation.' });
        return;
      }

      const questions = await generateInterviewQuestions(resume, jd);
      res.json({
        success: true,
        questions
      });
    } catch (err: any) {
      console.error('Server interview questions error:', err);
      res.status(500).json({ error: 'Failed to generate interview questions.' });
    }
  });

  // Endpoint 7: Generate Sample Answer (STAR method)
  app.post('/api/ai/sample-answer', async (req, res) => {
    try {
      const { question, context, resume, jd } = req.body;
      if (!question || !resume || !jd) {
        res.status(400).json({ error: 'Question, resume, and job description are required.' });
        return;
      }

      const answer = await generateSampleAnswer(question, context || '', resume, jd);
      res.json({
        success: true,
        answer
      });
    } catch (err: any) {
      console.error('Server sample answer error:', err);
      res.status(500).json({ error: 'Failed to generate sample answer.' });
    }
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CareerMatch AI Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Fatal server startup error:', err);
});
