import re, subprocess, sys
first, last = int(sys.argv[1]), int(sys.argv[2])
PDF = sys.argv[3] if len(sys.argv) > 3 else '/tmp/SRD2.pdf'
out=[]
for p in range(first, last+1):
    bb = subprocess.run(['pdftotext','-bbox','-f',str(p),'-l',str(p),PDF,'-'],capture_output=True,text=True).stdout
    words=[(float(a),float(b)) for a,b in re.findall(r'xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)"', bb)]
    best=None
    for x in range(240, 380):
        if not any(a < x < b for a,b in words):
            if best is None or abs(x-306) < abs(best-306): best = x
    g = best or 306
    for x,w in ((0,g),(g,612-g)):
        out.append(subprocess.run(['pdftotext','-layout','-f',str(p),'-l',str(p),'-x',str(x),'-y','0','-W',str(w),'-H','792',PDF,'-'],capture_output=True,text=True).stdout)
    print(p, g, file=sys.stderr)
sys.stdout.write(''.join(out))
