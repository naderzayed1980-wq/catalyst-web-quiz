"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuizEngine = void 0;
function normalize(v) { return v.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '').replace(/[.,،؛:!?؟()[\]{}"'`]/g, ' ').replace(/\s+/g, ' '); }
function textCorrect(q, input) { const s = normalize(input); if (!s)
    return false; return [q.correctAnswer, ...(q.acceptableAnswers || [])].map(normalize).filter(Boolean).some(a => s === a || (s.length >= 4 && a.includes(s)) || (a.length >= 4 && s.includes(a))); }
class QuizEngine {
    static evaluateQuestion(q, input) { const maxScore = Number(q.weight) > 0 ? Number(q.weight) : 5; let correct = false; let student = String(input); if (q.type === 'mcq') {
        const i = typeof input === 'number' ? input : Number(input);
        if (Number.isInteger(i) && i >= 0 && i < (q.options?.length || 0)) {
            correct = i === q.correctIndex;
            student = q.options?.[i] || student;
        }
        else
            correct = textCorrect(q, String(input));
    }
    else
        correct = textCorrect(q, String(input)); const score = correct ? maxScore : 0; const explanation = q.explanation || `الإجابة النموذجية: ${q.correctAnswer}`; const feedback = correct ? `✅ إجابة صحيحة! +${score}/${maxScore} درجة.\n💡 ${explanation}` : `❌ إجابة غير صحيحة. +0/${maxScore} درجة.\n📖 الإجابة النموذجية: ${q.correctAnswer}\n💡 ${explanation}${q.source ? `\n🔍 للمراجعة: ${q.source}` : ''}`; return { questionId: q.id, isCorrect: correct, scoreAwarded: score, maxScore, studentAnswer: student, correctAnswer: q.correctAnswer, feedback }; }
    static calculateQuizResult(qs, as) { const evaluations = qs.map(q => this.evaluateQuestion(q, as.find(a => a.questionId === q.id)?.studentInput ?? '')); const totalScore = evaluations.reduce((s, e) => s + e.scoreAwarded, 0), maxScore = evaluations.reduce((s, e) => s + e.maxScore, 0), percentage = Math.round(totalScore / Math.max(maxScore, 1) * 100); const summaryFeedback = percentage >= 90 ? 'مستوى ممتاز جداً. حافظ على هذا الأداء.' : percentage >= 75 ? 'أداء جيد جداً. راجع نقاط الضعف.' : percentage >= 50 ? 'أداء متوسط. أعد مراجعة المفاهيم والمخططات.' : 'يحتاج إلى مراجعة الدرس والتدريب من جديد.'; return { totalScore, maxScore, percentage, evaluations, summaryFeedback }; }
}
exports.QuizEngine = QuizEngine;
