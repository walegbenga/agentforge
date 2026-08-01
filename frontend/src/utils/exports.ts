import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { saveAs } from "file-saver";
import JSZip from "jszip";
import type { Task, Subtask } from "../types";
import { parseFileDeliverable } from "./fileDeliverable";

// 1. Sanitize Name for Filenames
export const getSafeFilename = (description: string, extension: string): string => {
  const safeName = description
    .substring(0, 50)
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase()
    .replace(/_+$/, "");
  
  return safeName ? `${safeName}.${extension}` : `file.${extension}`;
};

// 2. Check if Task Contains Code
export const hasCodeBlocks = (task: Task): boolean => {
  return task.subtasks.some((sub) => /```[\s\S]*?```/.test(sub.deliverable || ""));
};

// 3. PDF export is handled by react-to-print (see TaskReportPrintable.tsx +
// the useReactToPrint hook in TaskDetail.tsx) — it drives the browser's
// native print-to-PDF, producing real selectable/searchable text with
// correct page breaks. The previous html2pdf.js/html2canvas approach
// rasterized the page into an image, which is why long content and code
// blocks could get cut off or blurred across page boundaries.

// 4. Download Consolidated DOCX (Word)
export const downloadTaskDOCX = async (task: Task): Promise<void> => {
  const filename = getSafeFilename(task.description, "docx");

  const settledCount = task.subtasks.filter((s) => s.status === "settled").length;
  const disputedCount = task.subtasks.filter((s) => s.status === "disputed").length;
  const paidOut = task.subtasks.filter((s) => s.status === "settled").reduce((sum, s) => sum + s.budget, 0);

  const children: Paragraph[] = [
    new Paragraph({
      text: "FORGEOPS AI — TASK REPORT",
      spacing: { after: 100 },
      children: [new TextRun({ text: "FORGEOPS AI — TASK REPORT", size: 16, color: "6b7280", bold: true })],
    }),
    new Paragraph({
      text: task.description,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 150 },
    }),
    new Paragraph({
      spacing: { after: 400 },
      children: [
        new TextRun({
          text:
            `Total Budget: $${(task.totalBudget / 1_000_000).toFixed(2)} USDC   |   ` +
            `Paid Out: $${(paidOut / 1_000_000).toFixed(2)} USDC   |   ` +
            `Settled: ${settledCount}/${task.subtasks.length}   |   ` +
            `Disputed: ${disputedCount}/${task.subtasks.length}`,
          color: "6b7280",
          size: 20,
        }),
      ],
    }),
  ];

  task.subtasks.forEach((sub: Subtask, index: number) => {
    children.push(
      new Paragraph({
        text: `Subtask ${index + 1}: ${sub.description}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 60 },
      }),
      new Paragraph({
        spacing: { after: 150 },
        children: [
          new TextRun({
            text: `Agent: ${sub.assignedAgent?.name || "Unassigned"}   |   Capability: ${sub.capability}   |   ` +
              `Budget: $${(sub.budget / 1_000_000).toFixed(2)} USDC   |   Status: ${sub.status.toUpperCase()}`,
            italics: true,
            color: "6b7280",
            size: 18,
          }),
        ],
      })
    );

    if (sub.status === "disputed") {
      children.push(
        new Paragraph({
          spacing: { after: 100 },
          children: [
            new TextRun({
              text: "⚠ This subtask was disputed and did not settle.",
              bold: true,
              color: "a3231a",
            }),
            ...(sub.error ? [new TextRun({ text: `  Reason: ${sub.error}`, color: "a3231a", break: 1 })] : []),
          ],
        })
      );
    }

    if (!sub.deliverable) {
      children.push(
        new Paragraph({
          spacing: { after: 200 },
          children: [new TextRun({ text: `No deliverable — still ${sub.status}.`, italics: true, color: "9ca3af" })],
        })
      );
      return;
    }

    // Split on fenced code blocks so code renders as real monospace text
    // instead of being stripped to a "[Code Block]" placeholder.
    const parts = sub.deliverable.split(/```(?:\w+)?\n?([\s\S]*?)```/g);
    parts.forEach((part, i) => {
      const isCode = i % 2 === 1; // odd indices are the captured code group
      if (!part.trim()) return;

      if (isCode) {
        const lines = part.replace(/\n$/, "").split("\n");
        children.push(
          new Paragraph({
            spacing: { before: 100, after: 200 },
            shading: { fill: "F4F5F7" },
            children: lines.flatMap((line, li) => [
              ...(li > 0 ? [new TextRun({ text: "", break: 1 })] : []),
              new TextRun({ text: line || " ", font: "Courier New", size: 18 }),
            ]),
          })
        );
      } else {
        const cleanText = part
          .replace(/#{1,6}\s/g, "")
          .replace(/\*\*/g, "")
          .replace(/\*/g, "")
          .trim();
        if (!cleanText) return;
        children.push(
          new Paragraph({
            children: [new TextRun(cleanText)],
            spacing: { after: 200 },
          })
        );
      }
    });
  });

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, filename);
};

// 5. Smart Code Download with Descriptive Filenames
export const downloadTaskCode = (task: Task): void => {
  const taskNameBase = getSafeFilename(task.description, "").replace(/\.$/, "") || "forgeops_task";

  // Real per-subtask files (from app-builder's "### FILE: path" format) get
  // their real relative paths in the zip — an actual project structure,
  // not a flat pile of numbered snippets.
  const realFiles: { path: string; content: string }[] = [];
  const looseCodeBlocks: { lang: string; code: string; subtaskIndex: number; description: string }[] = [];

  task.subtasks.forEach((sub, index) => {
    if (!sub.deliverable) return;
    const parsed = parseFileDeliverable(sub.deliverable);
    if (parsed) {
      const subtaskFolder = getSafeFilename(sub.description, "").replace(/\.$/, "") || `subtask_${index + 1}`;
      parsed.files.forEach((file) => {
        // Namespace by subtask when there's more than one app-builder
        // subtask, so files from different subtasks don't collide.
        const prefix = task.subtasks.filter((s) => s.deliverable && parseFileDeliverable(s.deliverable)).length > 1
          ? `${subtaskFolder}/`
          : "";
        realFiles.push({ path: `${prefix}${file.path}`, content: file.content });
      });
      return;
    }

    const matches = sub.deliverable.matchAll(/```(\w+)?\n([\s\S]*?)```/g);
    for (const match of matches) {
      looseCodeBlocks.push({
        lang: match[1] || "txt",
        code: match[2],
        subtaskIndex: index,
        description: sub.description,
      });
    }
  });

  if (realFiles.length === 0 && looseCodeBlocks.length === 0) {
    alert("No code found in this task!");
    return;
  }

  // Single loose snippet, no real files — just download the one file directly.
  if (realFiles.length === 0 && looseCodeBlocks.length === 1) {
    const ext = looseCodeBlocks[0].lang === "javascript" ? "js" : looseCodeBlocks[0].lang;
    const fileBase = getSafeFilename(looseCodeBlocks[0].description, "").replace(/\.$/, "") || taskNameBase;
    const blob = new Blob([looseCodeBlocks[0].code], { type: "text/plain" });
    saveAs(blob, `${fileBase}.${ext}`);
    return;
  }

  const zip = new JSZip();
  realFiles.forEach((file) => zip.file(file.path, file.content));
  looseCodeBlocks.forEach((block) => {
    const ext = block.lang === "javascript" ? "js" : block.lang;
    const fileBase = getSafeFilename(block.description, "").replace(/\.$/, "") || `subtask_${block.subtaskIndex + 1}`;
    zip.file(`${fileBase}.${ext}`, block.code);
  });

  zip.generateAsync({ type: "blob" }).then((blob) => {
    saveAs(blob, `${taskNameBase}_source_code.zip`);
  });
};