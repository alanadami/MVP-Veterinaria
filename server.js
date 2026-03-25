const express = require('express');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();

const OpenAI = require('openai');
const fs = require('fs');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function getLocalDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function extractOutputText(response) {
  if (!response) return '';
  if (typeof response.output_text === 'string') return response.output_text;
  const output = response.output;
  if (!Array.isArray(output)) return '';
  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return '';
}

function sanitizeJsonText(text) {
  if (!text) return '';
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const atendimentos = new Map();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '.webm');
  }
});

const upload = multer({ storage });

app.post('/criar-atendimento', (req, res) => {
  const { nome } = req.body || {};
  const atendimentoId = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createdAt = new Date();
  const atendimento = {
    id: atendimentoId,
    nome: (nome || 'Animal sem nome').toString().trim() || 'Animal sem nome',
    createdAt: createdAt.toISOString(),
    createdDate: getLocalDateString(createdAt),
    transcricoes: [],
    finalizado: false,
    estruturado: null,
    estruturadoRaw: null
  };
  atendimentos.set(atendimentoId, atendimento);
  res.json(atendimento);
});

app.get('/atendimentos', (req, res) => {
  const lista = Array.from(atendimentos.values()).map((item) => ({
    id: item.id,
    nome: item.nome,
    createdAt: item.createdAt,
    createdDate: item.createdDate,
    finalizado: item.finalizado,
    transcricoesCount: item.transcricoes.length
  }));
  res.json({ atendimentos: lista });
});

app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    console.log('Arquivo recebido:', req.file);

    const filePath = req.file.path;
    const atendimentoId = req.body.atendimentoId;
    const nome = req.body.nome;

    if (!atendimentoId) {
      return res.status(400).json({ error: 'atendimentoId é obrigatório' });
    }

    // 1. Transcrição
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'gpt-4o-transcribe'
    });

    const texto = transcription.text;
    console.log('Texto transcrito:', texto);

    let atendimentoAtual = atendimentos.get(atendimentoId);
    if (!atendimentoAtual) {
      const createdAt = new Date();
      atendimentoAtual = {
        id: atendimentoId,
        nome: (nome || 'Animal sem nome').toString().trim() || 'Animal sem nome',
        createdAt: createdAt.toISOString(),
        createdDate: getLocalDateString(createdAt),
        transcricoes: [],
        finalizado: false,
        estruturado: null,
        estruturadoRaw: null
      };
    }
    atendimentoAtual.transcricoes.push(texto);
    atendimentoAtual.finalizado = false;
    atendimentoAtual.estruturado = null;
    atendimentoAtual.estruturadoRaw = null;
    atendimentos.set(atendimentoId, atendimentoAtual);

    res.json({
      texto,
      totalTranscricoes: atendimentoAtual.transcricoes.length,
      atendimento: {
        id: atendimentoAtual.id,
        nome: atendimentoAtual.nome,
        createdDate: atendimentoAtual.createdDate
      }
    });

  } catch (error) {
    console.error('Erro geral:', error.response?.data || error.message);

    res.status(500).json({
        error: 'Erro ao processar atendimento'
    });
    }
});

app.post('/finalizar-atendimento', async (req, res) => {
  try {
    const { atendimentoId } = req.body;

    if (!atendimentoId) {
      return res.status(400).json({ error: 'atendimentoId é obrigatório' });
    }

    const atendimentoAtual = atendimentos.get(atendimentoId);
    if (!atendimentoAtual || atendimentoAtual.transcricoes.length === 0) {
      return res.status(400).json({ error: 'Nenhuma transcrição encontrada' });
    }

    const textoCompleto = atendimentoAtual.transcricoes.join('\n\n');

    const responseIA = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: `
Consolide o atendimento a partir do texto abaixo.

Extraia:
- medicamentos (nome e quantidade)
- procedimentos
- observacoes (texto curto opcional)

Responda APENAS em JSON válido, sem explicações.

Formato:
{
  "medicamentos": [{"nome": "", "quantidade": ""}],
  "procedimentos": [],
  "observacoes": ""
}

Texto:
${textoCompleto}
`
    });

    const estruturadoRaw = sanitizeJsonText(extractOutputText(responseIA));
    let estruturado = null;
    try {
      estruturado = JSON.parse(estruturadoRaw);
    } catch (e) {
      estruturado = null;
    }

    atendimentoAtual.finalizado = true;
    atendimentoAtual.estruturado = estruturado;
    atendimentoAtual.estruturadoRaw = estruturado ? null : estruturadoRaw;
    atendimentos.set(atendimentoId, atendimentoAtual);

    res.json({
      transcricoes: atendimentoAtual.transcricoes,
      estruturado,
      estruturadoRaw: estruturado ? null : estruturadoRaw
    });
  } catch (error) {
    console.error('Erro ao finalizar atendimento:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erro ao finalizar atendimento',
      details: error.response?.data || error.message
    });
  }
});

app.post('/gerar-relatorio', (req, res) => {
  const { medicamentos, procedimentos, observacoes } = req.body || {};

  const listaMeds = Array.isArray(medicamentos) ? medicamentos : [];
  const listaProcs = Array.isArray(procedimentos) ? procedimentos : [];

  const linhas = [];
  linhas.push('Relatório de Atendimento');
  linhas.push('');
  linhas.push('Medicamentos:');
  if (listaMeds.length === 0) {
    linhas.push('- Nenhum');
  } else {
    for (const med of listaMeds) {
      const nome = (med?.nome || '').trim();
      const qtd = (med?.quantidade || '').trim();
      linhas.push(`- ${nome}${qtd ? ' (' + qtd + ')' : ''}`);
    }
  }
  linhas.push('');
  linhas.push('Procedimentos:');
  if (listaProcs.length === 0) {
    linhas.push('- Nenhum');
  } else {
    for (const proc of listaProcs) {
      const item = (proc || '').toString().trim();
      linhas.push(`- ${item}`);
    }
  }
  if (observacoes) {
    linhas.push('');
    linhas.push('Observações:');
    linhas.push(observacoes.toString().trim());
  }

  res.json({ relatorio: linhas.join('\n') });
});

app.get('/relatorio-diario', (req, res) => {
  const date = (req.query.date || '').toString().trim() || getLocalDateString(new Date());
  const atendimentosDoDia = Array.from(atendimentos.values()).filter(
    (item) => item.createdDate === date
  );

  const linhas = [];
  linhas.push(`Relatório geral do dia ${date}`);
  linhas.push('');

  if (atendimentosDoDia.length === 0) {
    linhas.push('Nenhum atendimento registrado neste dia.');
    return res.json({ relatorio: linhas.join('\n') });
  }

  for (const item of atendimentosDoDia) {
    linhas.push(`Paciente: ${item.nome}`);
    if (!item.finalizado || (!item.estruturado && !item.estruturadoRaw)) {
      linhas.push('- Atendimento pendente de finalização.');
      linhas.push('');
      continue;
    }

    const estruturado = item.estruturado;
    if (!estruturado) {
      linhas.push('- Não foi possível ler o JSON estruturado.');
      linhas.push('');
      continue;
    }

    const meds = Array.isArray(estruturado.medicamentos) ? estruturado.medicamentos : [];
    const procs = Array.isArray(estruturado.procedimentos) ? estruturado.procedimentos : [];

    linhas.push('Medicamentos:');
    if (meds.length === 0) {
      linhas.push('- Nenhum');
    } else {
      for (const med of meds) {
        const nome = (med?.nome || '').trim();
        const qtd = (med?.quantidade || '').trim();
        linhas.push(`- ${nome}${qtd ? ' (' + qtd + ')' : ''}`);
      }
    }
    linhas.push('Procedimentos:');
    if (procs.length === 0) {
      linhas.push('- Nenhum');
    } else {
      for (const proc of procs) {
        const itemProc = (proc || '').toString().trim();
        linhas.push(`- ${itemProc}`);
      }
    }
    if (estruturado.observacoes) {
      linhas.push(`Observações: ${estruturado.observacoes.toString().trim()}`);
    }
    linhas.push('');
  }

  res.json({ relatorio: linhas.join('\n') });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Servidor rodando na porta 3000');
});
