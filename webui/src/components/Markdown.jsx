import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 标准 markdown 渲染管线（react-markdown + remark-gfm，与 pi-web-ui 同款方案）。
 * react-markdown 默认不渲染原生 HTML——XSS 面比手写转义渲染器小得多。
 * 表格/代码样式走 .bubble 下的元素选择器（style.css）。
 */
export const Markdown = memo(function Markdown({ text }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
