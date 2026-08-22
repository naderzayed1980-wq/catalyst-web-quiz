import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import multer from 'multer';
import mammoth from 'mammoth';
const pdfParse = require('pdf-parse') as (data: Buffer) => Promise<{ text: string }>;
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { QuizEngine, Question, StudentAnswer, QuestionType } from './src/lib/quizEngine';

dotenv.config();

interface Student { phone:string; name:string; grade:string; groupIds:string[]; active:boolean; status:'PENDING'|'APPROVED'|'REJECTED'; email?:string; school?:string; createdAt:string; approvedAt?:string; }
interface Group { id:string; name:string; grade:string; chatId:string; active:boolean; }
interface Quiz { id:string; title:string; grade:string; groupIds:string[]; active:boolean; archived?:boolean; archivedAt?:string; questions:Question[]; updatedAt:string; order?:number; sourceFiles?:SourceFile[]; }
interface SourceFile { id:string; originalName:string; storedName:string; url:string; mime:string; extractedText:string; attachments:string[]; createdAt:string; }
interface Session { key:string; studentPhone:string; chatId:string; groupId?:string; quizId:string; quizQueue:string[]; sequenceMode:boolean; currentQuestionIndex:number; answers:StudentAnswer[]; status:'MENU'|'IN_PROGRESS'|'COMPLETED'; startedAt:string; updatedAt:string; }
interface Result { id:string; phone:string; studentName:string; chatId:string; quizId:string; grade:string; groupId?:string; totalScore:number; maxScore:number; percentage:number; evaluations:ReturnType<typeof QuizEngine.calculateQuizResult>['evaluations']; date:string; }
interface Store { students:Record<string,Student>; groups:Record<string,Group>; quizzes:Record<string,Quiz>; sessions:Record<string,Session>; results:Result[]; processedMessages:Record<string,string>; sources:Record<string,SourceFile>; }

const app=express(); app.use(cors()); app.use(express.json({limit:'10mb'}));
app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');next();});

const PUBLIC=path.join(process.cwd(),'public'); 
const UPLOAD_DIR=process.env.VERCEL ? path.join('/tmp','uploads') : path.join(PUBLIC,'uploads'); 
fs.mkdirSync(UPLOAD_DIR,{recursive:true});

// ضبط الملفات الاستاتيكية وفق المعايير السحابية
app.use(express.static(PUBLIC));

app.get('/admin',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(PUBLIC,'admin.html'));});
app.get('/student',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(PUBLIC,'student.html'));});
app.get('/',(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(PUBLIC,'student.html'));});
const upload=multer({dest:path.join(UPLOAD_DIR,'_tmp'),limits:{fileSize:50*1024*1024}});
const PORT=Number(process.env.PORT||4000); 
const WAHA_URL=(process.env.WAHA_URL||'http://localhost:3001').replace(/\/+$/,''); 
const WAHA_SESSION=process.env.WAHA_SESSION||'catalyst'; 
const ADMIN_API_KEY=process.env.ADMIN_API_KEY||''; 
const WEBHOOK_SECRET=process.env.WEBHOOK_SECRET||''; 
const DATA_FILE=process.env.VERCEL ? path.join('/tmp','store.json') : path.resolve(process.env.DATA_FILE||'./data/store.json'); 
const GEMINI_API_KEY=process.env.GEMINI_API_KEY||''; 
const GEMINI_MODEL=process.env.GEMINI_MODEL||'gemini-3.6-flash';

const emptyStore=():Store=>({students:{},groups:{},quizzes:{},sessions:{},results:[],processedMessages:{},sources:{}});
function loadStore():Store{fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});if(!fs.existsSync(DATA_FILE))fs.writeFileSync(DATA_FILE,JSON.stringify(emptyStore(),null,2));try{const p=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));const sessions=p.sessions||{};for(const k of Object.keys(sessions)){sessions[k]={quizQueue:[],sequenceMode:false,status:'COMPLETED',...sessions[k]};}for(const q of Object.values(p.quizzes||{})){(q as any).order=Number((q as any).order??9999);}return {...emptyStore(),...p,students:p.students||{},groups:p.groups||{},quizzes:p.quizzes||{},sessions,results:p.results||[],processedMessages:p.processedMessages||{},sources:p.sources||{}};}catch{return emptyStore();}}
let store=loadStore(); function save(){fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(store,null,2));fs.renameSync(tmp,DATA_FILE);}
function cleanPhone(raw:string){return String(raw||'').trim().replace(/[^\d]/g,'');} function phone(raw:string){const s=String(raw||'').trim();return s.endsWith('@c.us')?s:`${cleanPhone(s)}@c.us`;}
function normalizeGrade(raw:string){return String(raw||'').trim().toLowerCase().replace(/[Ø¥Ø£Ø¢]/g,'Ø§').replace(/Ù‰/g,'ÙŠ').replace(/Ø©/g,'Ù‡').replace(/Ø§Ù„ØµÙ/g,'').replace(/Ø§Ù„/g,'').replace(/\s+/g,'').replace(/Ø§Ù„Ø£ÙˆÙ„Ù‰|Ø§Ù„Ø§ÙˆÙ„Ù‰|Ø§ÙˆÙ„Ù‰|Ø§ÙˆÙ„ÙŠ|Ø§Ù„Ø£ÙˆÙ„|Ø§Ù„Ø§ÙˆÙ„|Ø§ÙˆÙ„/g,'1').replace(/Ø§Ù„Ø«Ø§Ù†ÙŠØ©|Ø§Ù„Ø«Ø§Ù†ÙŠÙ‡|Ø§Ù„ØªØ§Ù†ÙŠØ©|Ø§Ù„ØªØ§Ù†ÙŠÙ‡|Ø§Ù„Ø«Ø§Ù†ÙŠ|Ø§Ù„ØªØ§Ù†ÙŠ|Ø«Ø§Ù†ÙŠØ©|ØªØ§Ù†ÙŠØ©/g,'2').replace(/Ø§Ù„Ø«Ø§Ù„Ø«Ø©|Ø§Ù„Ø«Ø§Ù„Ø«Ù‡|Ø§Ù„ØªØ§Ù„ØªØ©|Ø§Ù„ØªØ§Ù„ØªÙ‡|Ø§Ù„Ø«Ø§Ù„Ø«|Ø§Ù„ØªØ§Ù„Øª|Ø«Ø§Ù„Ø«Ø©|ØªØ§Ù„ØªØ©/g,'3');}
function sameGrade(a:string,b:string){const x=normalizeGrade(a),y=normalizeGrade(b);return x===y || x.includes(y) || y.includes(x);}

function admin(req:Request,res:Response,next:NextFunction){if(!ADMIN_API_KEY||req.header('x-api-key')!==ADMIN_API_KEY)return res.status(401).json({error:'ØºÙŠØ± Ù…ØµØ±Ø­: ØªØ­Ù‚Ù‚ Ù…Ù† ADMIN_API_KEY'});next();}
function webhookOk(req:Request){return !WEBHOOK_SECRET||req.header('x-webhook-secret')===WEBHOOK_SECRET;}

async function waha(endpoint:string,body:unknown){
  const headers:any={'Content-Type':'application/json'};
  if(process.env.WAHA_API_KEY) headers['X-Api-Key']=process.env.WAHA_API_KEY;
  const r=await fetch(`${WAHA_URL}${endpoint}`,{method:'POST',headers,body:JSON.stringify(body)});
  if(!r.ok){
    const errText = await r.text().catch(() => '');
    console.error(`[WAHA ERROR ${r.status}]:`, errText);
    throw new Error(`WAHA ${r.status}: ${errText}`);
  }
  return r.json().catch(()=>({}));
}

async function sendText(chatId:string,text:string){
  return waha(`/api/${WAHA_SESSION}/sendText`,{
    chatId,
    text
  });
}

async function sendImage(chatId:string,url:string,caption:string){
  return waha(`/api/${WAHA_SESSION}/sendImage`,{
    chatId,
    file:{url},
    caption
  });
}

function incoming(payload: any) {
  const m = payload?.payload || payload?.data || payload;
  if (!m) return null;

  const rawChatId = String(m.from || m.chatId || m._data?.id?.remote || '');
  if (!rawChatId) return null;

  const isGroup = rawChatId.endsWith('@g.us');

  let rawAuthor = isGroup 
    ? String(m.participant || m.author || m._data?.author || '') 
    : rawChatId;

  if (rawAuthor.endsWith('@lid') || rawChatId.endsWith('@lid')) {
    const alt = m._data?.Info?.SenderAlt || m._data?.Info?.ChatAlt || m.fromAlt || '';
    if (alt) {
      rawAuthor = alt;
    }
  }

  const studentPhone = phone(rawAuthor);

  return {
    chatId: rawChatId,
    groupId: isGroup ? rawChatId : undefined,
    studentPhone,
    text: String(m.body || m.text || m._data?.body || '').trim(),
    fromMe: Boolean(m.fromMe),
    messageId: String(m.id || m.messageId || m._data?.id?._serialized || m._data?.id?.id || '')
  };
}

function belongs(s:Student,g?:string){return !g||s.groupIds.includes('*')||s.groupIds.includes(g);}
function availableQuizzes(s:Student,g?:string){return Object.values(store.quizzes).filter(q=>{if(q.archived||!q.active||!sameGrade(q.grade,s.grade))return false;if(!g)return q.groupIds.includes('*')||q.groupIds.length===0||q.groupIds.some(x=>s.groupIds.includes(x));return belongs(s,g)&&(q.groupIds.includes('*')||q.groupIds.length===0||q.groupIds.includes(g));}).sort((a,b)=>((a.order??9999)-(b.order??9999))||b.updatedAt.localeCompare(a.updatedAt));}
function chooseQuiz(s:Student,g?:string){return availableQuizzes(s,g)[0];}
function quizMenu(qs:Quiz[]){let m='ðŸ“š *Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª Ø§Ù„Ù…ØªØ§Ø­Ø©*\n\n';qs.forEach((q,i)=>m+=`${i+1}) ${q.title} â€” ${q.questions.length} Ø³Ø¤Ø§Ù„\n`);m+='\nðŸŽ¯ *Ø§Ø®ØªÙŠØ§Ø± Ø§Ø®ØªØ¨Ø§Ø±:* Ø£Ø±Ø³Ù„ Ø±Ù‚Ù…Ù‡ Ù…Ø«Ù„ 2.\nâ–¶ï¸ *Ø­Ù„ Ø¨Ø§Ù„ØªØªØ§Ø¨Ø¹:* Ø£Ø±Ø³Ù„ Ù…ØªØªØ§Ø¨Ø¹.\nâ†©ï¸ *Ø¥Ù„ØºØ§Ø¡:* Ø£Ø±Ø³Ù„ Ø¥Ù„ØºØ§Ø¡.';return m;}
function startSession(s:Session,q:Quiz,sequence:string[]){s.quizId=q.id;s.quizQueue=sequence;s.sequenceMode=sequence.length>0;s.currentQuestionIndex=0;s.answers=[];s.status='IN_PROGRESS';s.startedAt=new Date().toISOString();s.updatedAt=new Date().toISOString();}

function parseAnswer(q:Question,text:string):string|number{if(q.type!=='mcq')return text;const map:Record<string,number>={'Ø£':0,'Ø§':0,'1':0,'a':0,'Ø¨':1,'2':1,'b':1,'Ø¬':2,'3':2,'c':2,'Ø¯':3,'4':3,'d':3,'Ù‡Ù€':4,'Ù‡':4,'5':4,'e':4};const k=text.trim().toLowerCase();return map[k]??text;}
async function ask(s:Session){const quiz=store.quizzes[s.quizId],q=quiz?.questions[s.currentQuestionIndex];if(!quiz||!q)return;if(q.imageUrl)await sendImage(s.chatId,q.imageUrl,`ðŸ“ Ø§Ù„Ù…Ø±ÙÙ‚ Ø§Ù„Ø¹Ù„Ù…ÙŠ Ù„Ù„Ø³Ø¤Ø§Ù„ ${s.currentQuestionIndex+1}`);let msg=`â“ *${quiz.title}*\nØ§Ù„Ø³Ø¤Ø§Ù„ (${s.currentQuestionIndex+1}/${quiz.questions.length}) â€” ${q.weight} Ø¯Ø±Ø¬Ø§Øª\n\n${q.question}\n\n`;if(q.type==='mcq'&&q.options?.length){const labels=['Ø£','Ø¨','Ø¬','Ø¯','Ù‡Ù€','Ùˆ'];q.options.forEach((o,i)=>msg+=`${labels[i]||i+1}) ${o}\n`);msg+='\nâœï¸ Ø£Ø±Ø³Ù„ Ø­Ø±Ù Ø§Ù„Ø§Ø®ØªÙŠØ§Ø± Ø£Ùˆ Ø±Ù‚Ù…Ù‡.';}else msg+='\nâœï¸ Ø§ÙƒØªØ¨ Ø¥Ø¬Ø§Ø¨ØªÙƒ Ù…Ø¨Ø§Ø´Ø±Ø©.';await sendText(s.chatId,msg);}
async function finish(s:Session,student:Student,quiz:Quiz){s.status='COMPLETED';s.updatedAt=new Date().toISOString();const r=QuizEngine.calculateQuizResult(quiz.questions,s.answers);store.results.unshift({id:crypto.randomUUID(),phone:student.phone,studentName:student.name,chatId:s.chatId,quizId:quiz.id,grade:student.grade,groupId:s.groupId,totalScore:r.totalScore,maxScore:r.maxScore,percentage:r.percentage,evaluations:r.evaluations,date:new Date().toISOString()});save();let report=`ðŸ† *Ù†ØªÙŠØ¬Ø© Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±*\nðŸ“š ${quiz.title}\nðŸ‘¨â€ðŸŽ“ ${student.name}\nðŸŽ¯ *${r.totalScore}/${r.maxScore}* (${r.percentage}%)\nðŸ“Š ${r.summaryFeedback}\n\nðŸ“`;r.evaluations.forEach((e,i)=>report+=`\n${i+1}. ${e.isCorrect?'âœ…':'âŒ'} ${e.scoreAwarded}/${e.maxScore}`);await sendText(s.chatId,report);if(s.sequenceMode){let next:Quiz|undefined;while(s.quizQueue.length&&!next){const nextId=s.quizQueue.shift()!;const candidate=store.quizzes[nextId];if(candidate&&candidate.active)next=candidate;}if(next){startSession(s,next,s.quizQueue);save();await sendText(s.chatId,`\nâž¡ï¸ *Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± Ø§Ù„ØªØ§Ù„ÙŠ*\nðŸ“š ${next.title}\nØ³ÙŠØ¨Ø¯Ø£ Ø§Ù„Ø¢Ù†.`);await ask(s);}else{await sendText(s.chatId,'ðŸŽ‰ Ø§Ù†ØªÙ‡Øª Ø³Ù„Ø³Ù„Ø© Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª Ø¨Ø§Ù„ÙƒØ§Ù…Ù„.');s.status='COMPLETED';save();}}else{await sendText(s.chatId,'\nðŸ“Œ Ø£Ø±Ø³Ù„ *Ø§Ø®ØªØ¨Ø§Ø±* Ù„Ø§Ø®ØªÙŠØ§Ø± Ø§Ø®ØªØ¨Ø§Ø± Ø¢Ø®Ø± Ù…Ù† Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª Ø§Ù„Ù…ØªØ§Ø­Ø©.');}}
async function handle(chatId:string,studentPhone:string,groupId:string|undefined,text:string){const student=store.students[studentPhone];if(!student||student.status!=='APPROVED'||!student.active){await sendText(chatId,'ðŸš« Ø±Ù‚Ù…Ùƒ ØºÙŠØ± Ù…Ø¹ØªÙ…Ø¯ Ø¨Ø¹Ø¯. Ø³Ø¬Ù‘Ù„ Ø¨ÙŠØ§Ù†Ø§ØªÙƒ ÙˆØ§Ù†ØªØ¸Ø± Ù…ÙˆØ§ÙÙ‚Ø© Ø§Ù„Ù…Ø¯ÙŠØ±.');return;}if(groupId&&!belongs(student,groupId)){await sendText(chatId,'ðŸš« Ø£Ù†Øª ØºÙŠØ± Ù…ØµØ±Ø­ Ù„Ùƒ Ø¨Ù‡Ø°Ù‡ Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø©.');return;}const key=`${studentPhone}:${chatId}`;let s=store.sessions[key];const cmd=text.trim().toLowerCase();const qs=availableQuizzes(student,groupId);
if(['Ø¥Ù„ØºØ§Ø¡','Ø§Ù„ØºØ§Ø¡','cancel'].includes(cmd)){if(s){delete store.sessions[key];save();}await sendText(chatId,'ØªÙ… Ø¥Ù„ØºØ§Ø¡ Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±/Ø§Ù„Ø§Ø®ØªÙŠØ§Ø±.');return;}
if(['Ø§Ø®ØªØ¨Ø§Ø±','Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª','Ø¨Ø¯Ø¡','start'].includes(cmd)){if(!qs.length){await sendText(chatId,`âš ï¸ Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø§Ø®ØªØ¨Ø§Ø± Ù†Ø´Ø· Ù„Ù„ØµÙ ${student.grade} ÙˆØ§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø© Ø§Ù„Ø­Ø§Ù„ÙŠØ©.`);return;}if(s?.status==='IN_PROGRESS'){await ask(s);return;}s=s||{key,studentPhone,chatId,groupId,quizId:'',quizQueue:[],sequenceMode:false,currentQuestionIndex:0,answers:[],status:'MENU',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};s.status='MENU';store.sessions[key]=s;save();await sendText(chatId,`ðŸ‘‹ Ø£Ù‡Ù„Ø§Ù‹ ${student.name}!\nðŸŽ“ ${student.grade}\n\n${quizMenu(qs)}`);return;}
if((s?.status==='MENU'||!s)&&qs.length){let choice=-1;if(/^\d+$/.test(cmd))choice=Number(cmd)-1;else if(cmd.startsWith('Ø§Ø®ØªØ¨Ø§Ø± ')){const n=Number(cmd.slice(7).trim());if(Number.isInteger(n))choice=n-1;}if(cmd==='Ù…ØªØªØ§Ø¨Ø¹'||cmd==='ØªØªØ§Ø¨Ø¹'||cmd==='all'){s=s||{key,studentPhone,chatId,groupId,quizId:'',quizQueue:[],sequenceMode:false,currentQuestionIndex:0,answers:[],status:'MENU',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};const first=qs[0];startSession(s,first,qs.slice(1).map(q=>q.id));store.sessions[key]=s;save();await sendText(chatId,`â–¶ï¸ *Ø¨Ø¯Ø¡ Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª Ø¨Ø§Ù„ØªØªØ§Ø¨Ø¹*\nØ³ÙŠØªÙ… Ø­Ù„ ${qs.length} Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª Ø¨Ø§Ù„ØªØ±ØªÙŠØ¨.`);await ask(s);return;}if(choice>=0&&choice<qs.length){s=s||{key,studentPhone,chatId,groupId,quizId:'',quizQueue:[],sequenceMode:false,currentQuestionIndex:0,answers:[],status:'MENU',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};startSession(s,qs[choice],[]);store.sessions[key]=s;save();await sendText(chatId,`â–¶ï¸ *ØªÙ… Ø§Ø®ØªÙŠØ§Ø± Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±*\nðŸ“š ${qs[choice].title}`);await ask(s);return;}if(s?.status==='MENU'){await sendText(chatId,quizMenu(qs));return;}}
if(!s||s.status!=='IN_PROGRESS'){await sendText(chatId,'Ø£Ø±Ø³Ù„ ÙƒÙ„Ù…Ø© *Ø§Ø®ØªØ¨Ø§Ø±* Ù„Ø¹Ø±Ø¶ Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø±Ø§Øª Ø§Ù„Ù…ØªØ§Ø­Ø©.');return;}const quiz=store.quizzes[s.quizId],q=quiz?.questions[s.currentQuestionIndex];if(!quiz||!q){await sendText(chatId,'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ØªØ§Ø­.');return;}const input=parseAnswer(q,text),ev=QuizEngine.evaluateQuestion(q,input);s.answers.push({questionId:q.id,studentInput:input});s.currentQuestionIndex++;s.updatedAt=new Date().toISOString();save();await sendText(chatId,ev.feedback);if(s.currentQuestionIndex<quiz.questions.length)await ask(s);else await finish(s,student,quiz);}

app.post('/api/student/test/start',async(req,res)=>{
 const p=phone(String(req.body?.phone||'')); const quizId=String(req.body?.quizId||''); const student=store.students[p];
 if(!student||student.status!=='APPROVED'||!student.active)return res.status(403).json({error:'\u0627\u0644\u0637\u0627\u0644\u0628 \u063a\u064a\u0631 \u0645\u0639\u062a\u0645\u062f \u0645\u0646 \u0627\u0644\u0645\u062f\u064a\u0631'});
 const quiz=store.quizzes[quizId]; if(!quiz||!quiz.active||!sameGrade(quiz.grade,student.grade))return res.status(404).json({error:'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ØªØ§Ø­ Ù„Ù‡Ø°Ø§ Ø§Ù„Ø·Ø§Ù„Ø¨'});
 const key=`web:${p}`; store.sessions[key]={key,studentPhone:p,chatId:`web:${p}`,quizId:quiz.id,quizQueue:[],sequenceMode:false,currentQuestionIndex:0,answers:[],status:'IN_PROGRESS',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; save();
 res.json({success:true,quiz:{id:quiz.id,title:quiz.title,questions:quiz.questions.map(q=>({id:q.id,type:q.type,question:q.question,options:q.options||[],weight:q.weight,imageUrl:q.imageUrl||''}))},index:0});
});
app.post('/api/student/test/answer',async(req,res)=>{
 const p=phone(String(req.body?.phone||'')); const student=store.students[p]; const session=store.sessions[`web:${p}`];
 if(!student||student.status!=='APPROVED'||!student.active)return res.status(403).json({error:'\u0627\u0644\u0637\u0627\u0644\u0628 \u063a\u064a\u0631 \u0645\u0639\u062a\u0645\u062f \u0645\u0646 \u0627\u0644\u0645\u062f\u064a\u0631'});
 if(!session||session.status!=='IN_PROGRESS')return res.status(400).json({error:'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø§Ø®ØªØ¨Ø§Ø± Ø¬Ø§Ø±Ù'});
 const quiz=store.quizzes[session.quizId]; const q=quiz?.questions[session.currentQuestionIndex]; if(!quiz||!q)return res.status(400).json({error:'Ø§Ù„Ø³Ø¤Ø§Ù„ ØºÙŠØ± Ù…ØªØ§Ø­'});
 const input=parseAnswer(q,String(req.body?.answer??'')); const ev=QuizEngine.evaluateQuestion(q,input); session.answers.push({questionId:q.id,studentInput:input}); session.currentQuestionIndex++; session.updatedAt=new Date().toISOString();
 if(session.currentQuestionIndex>=quiz.questions.length){ const r=QuizEngine.calculateQuizResult(quiz.questions,session.answers); session.status='COMPLETED'; store.results.unshift({id:crypto.randomUUID(),phone:student.phone,studentName:student.name,chatId:session.chatId,quizId:quiz.id,grade:student.grade,groupId:student.groupIds[0],totalScore:r.totalScore,maxScore:r.maxScore,percentage:r.percentage,evaluations:r.evaluations,date:new Date().toISOString()}); save(); return res.json({completed:true,feedback:ev.feedback,result:{title:quiz.title,totalScore:r.totalScore,maxScore:r.maxScore,percentage:r.percentage,summary:r.summaryFeedback}}); }
 save(); const next=quiz.questions[session.currentQuestionIndex]; res.json({completed:false,quizId:quiz.id,feedback:ev.feedback,index:session.currentQuestionIndex,question:{id:next.id,type:next.type,question:next.question,options:next.options||[],weight:next.weight,imageUrl:next.imageUrl||''}});
});
app.get('/api/health',(_req,res)=>res.json({ok:true,geminiConfigured:Boolean(GEMINI_API_KEY),geminiModel:GEMINI_MODEL,students:Object.keys(store.students).length,pending:Object.values(store.students).filter(s=>s.status==='PENDING').length,groups:Object.keys(store.groups).length,quizzes:Object.keys(store.quizzes).length,results:store.results.length}));

app.post('/api/whatsapp/webhook',async(req,res)=>{
  console.log('ðŸ“© [WEBHOOK RECEIVED]:', JSON.stringify(req.body));
  if(!webhookOk(req))return res.status(401).json({error:'Invalid webhook secret'});
  try{
    const x=incoming(req.body);
    if(!x||x.fromMe||!x.text)return res.json({status:'IGNORED'});
    if(x.messageId&&store.processedMessages[x.messageId])return res.json({status:'DUPLICATE'});
    if(x.messageId)store.processedMessages[x.messageId]=new Date().toISOString();
    await handle(x.chatId,x.studentPhone,x.groupId,x.text);
    save();
    res.json({status:'SUCCESS'});
  }catch(e){
    console.error('âŒ Error handling message:', e);
    res.status(500).json({error:'Internal Server Error'});
  }
});

app.post('/api/register',async(req,res)=>{const{name,phone:raw,grade,groupId,email,school}=req.body||{};if(!name||!raw||!grade)return res.status(400).json({error:'Ø§Ù„Ø§Ø³Ù… ÙˆØ±Ù‚Ù… Ø§Ù„Ù‡Ø§ØªÙ ÙˆØ§Ù„ØµÙ Ù…Ø·Ù„ÙˆØ¨Ø©'});const p=phone(String(raw));const old=store.students[p];if(old?.status==='APPROVED')return res.status(409).json({error:'Ù‡Ø°Ø§ Ø§Ù„Ø±Ù‚Ù… Ù…Ø¹ØªÙ…Ø¯ Ø¨Ø§Ù„ÙØ¹Ù„'});const now=new Date().toISOString();store.students[p]={phone:p,name:String(name),grade:String(grade),groupIds:groupId?[String(groupId)]:[],active:false,status:'PENDING',email:email?String(email):'',school:school?String(school):'',createdAt:old?.createdAt||now};save();res.setHeader('Cache-Control','no-store');res.json({success:true,status:'PENDING',student:store.students[p],pendingCount:Object.values(store.students).filter(s=>s.status==='PENDING').length,message:'ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø§Ù„ØªØ³Ø¬ÙŠÙ„ Ù„Ù„Ù…Ø¯ÙŠØ± Ù„Ù„Ù…Ø±Ø§Ø¬Ø¹Ø©.'});});

app.post('/api/student/login', (req,res) => {
 const raw = String(req.body?.phone || '');
 if (!raw) return res.status(400).json({error:'Ø±Ù‚Ù… Ø§Ù„Ù‡Ø§ØªÙ Ù…Ø·Ù„ÙˆØ¨'});
 const p = phone(raw);
 const s = store.students[p];
 if (!s) return res.status(404).json({status:'NOT_REGISTERED',error:'هذا الرقم غير مسجل'});
 if (s.status !== 'APPROVED') {
   return res.json({status:s.status, approved:false, student:{name:s.name,phone:s.phone,grade:s.grade}});
 }
 if (!s.active) return res.json({status:'SUSPENDED', approved:false, student:{name:s.name,phone:s.phone,grade:s.grade}});
 const available = Object.values(store.quizzes).filter(q => !q.archived && q.active && sameGrade(q.grade,s.grade) && (q.groupIds.length===0 || q.groupIds.includes('*') || q.groupIds.some(g=>s.groupIds.includes(g))));
 
 return res.json({status:'APPROVED',approved:true,student:s,quizzes:available.map(q=>({id:q.id,title:q.title,grade:q.grade,groupIds:q.groupIds}))});
});

app.get('/api/students',admin,(_req,res)=>res.json({students:Object.values(store.students)}));
app.post('/api/students',admin,(req,res)=>{const{phone:raw,name='',grade,groupIds=[],active=true}=req.body;if(!raw||!grade)return res.status(400).json({error:'phone Ùˆ grade Ù…Ø·Ù„ÙˆØ¨Ø§Ù†'});const p=phone(String(raw));store.students[p]={phone:p,name:String(name),grade:String(grade),groupIds:Array.isArray(groupIds)?groupIds.map(String):[],active:Boolean(active),status:active?'APPROVED':'PENDING',createdAt:store.students[p]?.createdAt||new Date().toISOString(),approvedAt:active?new Date().toISOString():undefined};save();res.json({success:true,student:store.students[p]});});
app.patch('/api/students/:phone',admin,(req,res)=>{const p=phone(String(req.params.phone)),s=store.students[p];if(!s)return res.status(404).json({error:'Ø§Ù„Ø·Ø§Ù„Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});if(req.body.name!==undefined)s.name=String(req.body.name);if(req.body.grade!==undefined)s.grade=String(req.body.grade);if(req.body.active!==undefined)s.active=Boolean(req.body.active);if(Array.isArray(req.body.groupIds))s.groupIds=req.body.groupIds.map(String).filter(Boolean);save();res.json({success:true,student:s});});
app.post('/api/students/:phone/approve',admin,(req,res)=>{const p=phone(String(req.params.phone)),s=store.students[p];if(!s)return res.status(404).json({error:'Ø§Ù„Ø·Ø§Ù„Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});s.status='APPROVED';s.active=true;s.approvedAt=new Date().toISOString();if(Array.isArray(req.body.groupIds))s.groupIds=req.body.groupIds.map(String).filter(Boolean);save();res.json({success:true,student:s});});
app.post('/api/students/:phone/reject',admin,(req,res)=>{const p=phone(String(req.params.phone)),s=store.students[p];if(!s)return res.status(404).json({error:'Ø§Ù„Ø·Ø§Ù„Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});s.status='REJECTED';s.active=false;save();res.json({success:true,student:s});});
app.delete('/api/students/:phone',admin,(req,res)=>{const p=phone(String(req.params.phone));if(!store.students[p])return res.status(404).json({error:'Ø§Ù„Ø·Ø§Ù„Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});delete store.students[p];for(const [k,v] of Object.entries(store.sessions)){if(v.studentPhone===p)delete store.sessions[k];}save();res.json({success:true});});

app.get('/api/groups',admin,(_req,res)=>res.json({groups:Object.values(store.groups)}));
app.post('/api/groups',admin,(req,res)=>{const{id,name,grade,chatId,active=true}=req.body;if(!id||!name||!grade||!chatId)return res.status(400).json({error:'Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø© Ù†Ø§Ù‚ØµØ©'});store.groups[String(id)]={id:String(id),name:String(name),grade:String(grade),chatId:String(chatId),active:Boolean(active)};save();res.json({success:true,group:store.groups[String(id)]});});
app.patch('/api/groups/:id',admin,(req,res)=>{const g=store.groups[String(req.params.id)];if(!g)return res.status(404).json({error:'Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©'});Object.assign(g,req.body);save();res.json({success:true,group:g});});
app.delete('/api/groups/:id',admin,(req,res)=>{delete store.groups[String(req.params.id)];save();res.json({success:true});});

app.get('/api/quizzes',admin,(_req,res)=>res.json({quizzes:Object.values(store.quizzes).sort((a,b)=>Number(Boolean(a.archived))-Number(Boolean(b.archived)) || ((a.order??9999)-(b.order??9999)) || b.updatedAt.localeCompare(a.updatedAt))}));
app.post('/api/quizzes',admin,(req,res)=>{const{id,title,grade,groupIds=[],questions=[],active=false,sourceFiles=[],order=9999}=req.body;if(!id||!title||!grade||!Array.isArray(questions)||!questions.length)return res.status(400).json({error:'Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± Ù†Ø§Ù‚ØµØ©'});const safe=questions.map((q:Question,i:number)=>({...q,id:Number(q.id)||Date.now()+i,weight:Number(q.weight)>0?Number(q.weight):5,type:(q.type||'mcq') as QuestionType}));store.quizzes[String(id)]={id:String(id),title:String(title),grade:String(grade),groupIds:Array.isArray(groupIds)?groupIds.map(String):[],active:Boolean(active),archived:false,questions:safe,sourceFiles:Array.isArray(sourceFiles)?sourceFiles:[],order:Number(order)||9999,updatedAt:new Date().toISOString()};save();res.json({success:true,quiz:store.quizzes[String(id)]});});
app.post('/api/quizzes/:id/activate',admin,(req,res)=>{const q=store.quizzes[String(req.params.id)];if(!q)return res.status(404).json({error:'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});if(q.archived&&req.body?.active){return res.status(400).json({error:'Ø£Ø¹Ø¯ Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± Ù…Ù† Ø§Ù„Ø£Ø±Ø´ÙŠÙ Ø£ÙˆÙ„Ø§Ù‹'});}q.active=Boolean(req.body?.active);q.updatedAt=new Date().toISOString();save();res.json({success:true,quiz:q});});
app.post('/api/quizzes/:id/archive',admin,(req,res)=>{const q=store.quizzes[String(req.params.id)];if(!q)return res.status(404).json({error:'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});q.active=false;q.archived=true;q.archivedAt=new Date().toISOString();q.updatedAt=new Date().toISOString();for(const [k,v] of Object.entries(store.sessions)){if(v.quizId===q.id)delete store.sessions[k];}save();res.json({success:true,quiz:q});});
app.post('/api/quizzes/:id/restore',admin,(req,res)=>{const q=store.quizzes[String(req.params.id)];if(!q)return res.status(404).json({error:'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});q.archived=false;q.active=false;q.archivedAt=undefined;q.updatedAt=new Date().toISOString();save();res.json({success:true,quiz:q});});
app.delete('/api/quizzes/:id',admin,(req,res)=>{const id=String(req.params.id);const q=store.quizzes[id];if(!q)return res.status(404).json({error:'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});q.active=false;q.archived=true;q.archivedAt=new Date().toISOString();q.updatedAt=new Date().toISOString();save();res.json({success:true,archived:true});});
app.get('/api/quizzes/:id/pdf',admin,(req,res)=>{const q=store.quizzes[String(req.params.id)];if(!q)return res.status(404).json({error:'Ø§Ù„Ø§Ø®ØªØ¨Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(q.title||'quiz')}.pdf`);const doc=new PDFDocument({margin:45,size:'A4'});doc.pipe(res);const fontPath=path.join(__dirname,'assets','NotoSansArabic-Medium.ttf');if(fs.existsSync(fontPath))doc.font(fontPath);doc.fontSize(20).text(q.title,{align:'center'});doc.moveDown(.4);doc.fontSize(11).text(`Ø§Ù„ØµÙ: ${q.grade}    |    Ø¹Ø¯Ø¯ Ø§Ù„Ø£Ø³Ø¦Ù„Ø©: ${q.questions.length}`,{align:'right'});doc.moveDown();q.questions.forEach((item:any,i:number)=>{doc.fontSize(13).text(`${i+1}) ${item.question||''}`,{align:'right'});if(item.type==='mcq'&&Array.isArray(item.options)){item.options.forEach((o:string,j:number)=>doc.fontSize(11).text(`${['Ø£','Ø¨','Ø¬','Ø¯','Ù‡Ù€','Ùˆ'][j]||j+1}) ${o}`,{indent:15,align:'right'}));}if(item.imageUrl){const u=String(item.imageUrl);const fp=u.startsWith('/uploads/')?path.join(PUBLIC,u.replace(/^\/uploads\//,'')):'';if(fp&&fs.existsSync(fp)&&/\.(png|jpe?g|webp)$/i.test(fp)){try{doc.moveDown(.2);doc.image(fp,{fit:[450,220],align:'center'});}catch{}}}doc.moveDown(.5);});doc.end();});

app.get('/api/quiz/results',admin,(_req,res)=>res.json({results:store.results}));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Catalyst Server running on port ${PORT}`);
  });
}

export default app;