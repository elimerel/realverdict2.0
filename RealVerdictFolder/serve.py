import os, http.server, socketserver

os.chdir('/Users/elishamerel/Documents/RealVerdictFolder')
PORT = 5173
Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Serving at port {PORT}")
    httpd.serve_forever()
