"""Optional localhost BGE embeddings endpoint. Install torch and transformers first.

The bot adds the BGE query instruction; this endpoint only performs CLS pooling.
Weights are read locally unless --allow-download is explicitly supplied.
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()
    import torch
    from transformers import AutoModel, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=not args.allow_download)
    model = AutoModel.from_pretrained(args.model, local_files_only=not args.allow_download).eval()
    inference_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.path != "/v1/embeddings" or not 0 < length <= 65536:
                    raise ValueError("Invalid request")
                data = json.loads(self.rfile.read(length))
                texts = data.get("input")
                if not isinstance(texts, list) or not 1 <= len(texts) <= 16:
                    raise ValueError("Invalid batch")
                if any(not isinstance(text, str) or len(text) > 4000 for text in texts):
                    raise ValueError("Invalid input")
                with inference_lock, torch.inference_mode():
                    encoded = tokenizer(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
                    # BGE uses the first token, not the mean of all tokens.
                    vectors = torch.nn.functional.normalize(model(**encoded).last_hidden_state[:, 0], p=2, dim=1)
                    result = {"object": "list", "model": "bge-small-zh-v1.5", "data": [
                        {"index": index, "object": "embedding", "embedding": vector.tolist()}
                        for index, vector in enumerate(vectors)
                    ]}
                payload = json.dumps(result).encode("utf-8")
                self.send_response(200)
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                payload = b'{"error":"invalid embedding request"}'
                self.send_response(400)
            except Exception:
                payload = b'{"error":"embedding inference failed"}'
                self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format, *_args):
            pass  # Never log conversation text.

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"BGE CLS embeddings listening at http://127.0.0.1:{args.port}/v1/embeddings", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
