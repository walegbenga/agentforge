import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { saveAs } from "file-saver";
import JSZip from "jszip";
import html2pdf from "html2pdf.js";
import type { Task, Subtask } from "../types";

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

// 3. Generate PDF from Element (✅ UPDATED WITH CRITICAL FIXES)
export const generatePDF = async (element: HTMLElement, filename: string): Promise<void> => {
  const opt = {
    margin: 0.5,
    filename,
    image: { type: "jpeg", quality: 1 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      scrollY: 0, // 🔥 CRITICAL: Prevents cutoff/blank captures
      windowWidth: 800,
      logging: false,
    },
    jsPDF: {
      unit: "in",
      format: "letter",
      orientation: "portrait",
    },
  };

  // 🔥 THE ROBUST APPROACH: outputPdf() returns the jsPDF instance directly
  const pdfInstance = await html2pdf().set(opt).from(element).outputPdf();
  
  // Save the generated PDF
  pdfInstance.save(filename);
};

// 4. Download Consolidated DOCX (Word)
export const downloadTaskDOCX = async (task: Task): Promise<void> => {
  const filename = getSafeFilename(task.description, "docx");

  const children: Paragraph[] = [
    new Paragraph({
      text: task.description,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }),
    new Paragraph({
      text: `Total Budget: $${(task.totalBudget / 1_000_000).toFixed(2)} USDC`,
      spacing: { after: 400 },
    }),
  ];

  task.subtasks.forEach((sub: Subtask, index: number) => {
    if (!sub.deliverable) return;

    children.push(
      new Paragraph({
        text: `Subtask ${index + 1}: ${sub.description}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 100 },
      })
    );

    // Strip markdown syntax for clean Word document rendering
    const cleanText = sub.deliverable
      .replace(/```[\s\S]*?```/g, "[Code Block - See PDF or Code Download]")
      .replace(/#{1,6}\s/g, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "");

    children.push(
      new Paragraph({
        children: [new TextRun(cleanText)],
        spacing: { after: 200 },
      })
    );
  });

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, filename);
};

// 5. Smart Code Download with Descriptive Filenames
export const downloadTaskCode = (task: Task): void => {
  const codeBlocks: { lang: string; code: string; subtaskIndex: number; description: string }[] = [];

  task.subtasks.forEach((sub, index) => {
    if (!sub.deliverable) return;
    const matches = sub.deliverable.matchAll(/```(\w+)?\n([\s\S]*?)```/g);
    for (const match of matches) {
      codeBlocks.push({
        lang: match[1] || "txt",
        code: match[2],
        subtaskIndex: index,
        description: sub.description,
      });
    }
  });

  if (codeBlocks.length === 0) {
    alert("No code blocks found in this task!");
    return;
  }

  const taskNameBase = getSafeFilename(task.description, "").replace(/\./g, "") || "agentforge_task";

  if (codeBlocks.length === 1) {
    // Single file: Use the subtask description for a meaningful name
    const ext = codeBlocks[0].lang === "javascript" ? "js" : codeBlocks[0].lang;
    const fileBase = getSafeFilename(codeBlocks[0].description, "").replace(/\./g, "") || taskNameBase;
    const blob = new Blob([codeBlocks[0].code], { type: "text/plain" });
    saveAs(blob, `${fileBase}.${ext}`);
  } else {
    // Multiple files: Create a ZIP with descriptive names
    const zip = new JSZip();
    codeBlocks.forEach((block) => {
      const ext = block.lang === "javascript" ? "js" : block.lang;
      const fileBase = getSafeFilename(block.description, "").replace(/\./g, "") || `subtask_${block.subtaskIndex + 1}`;
      zip.file(`${fileBase}.${ext}`, block.code);
    });
    
    zip.generateAsync({ type: "blob" }).then((blob) => {
      saveAs(blob, `${taskNameBase}_source_code.zip`);
    });
  }
};